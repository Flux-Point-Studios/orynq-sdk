#!/usr/bin/env python3
"""Independent, read-only standing-service monitoring with a durable alert outbox."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import select
import sqlite3
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

BOUND = 2 * 1024 * 1024
NETWORK_DEADLINE = 20
PER_DAY = 100_000_000_000_000
EXPORT_COMMAND = 'python3 /home/deci/.local/lib/orynq-midnight-standing/checkout/packages/anchors-midnight-submit/runner/standing-watch.py --export'

def integer(value):
    if type(value) is not int or value < 0 or value > 2**53-1:
        raise ValueError('invalid integer')
    return value

def evaluate(value, scope, mode, now, fetched_at, remote_height):
    try:
        integer(now);integer(fetched_at);integer(remote_height)
        data = value['status']
        if data['format'] != 'orynq-midnight-standing-status/v1' or data['phase'] not in ('starting','wallet-sync','catchup','running','stopping','stopped'):
            raise ValueError('invalid format')
        codes = []
        if data['scope'] != scope or data['mode'] != mode:
            codes.append('scope-mismatch')
        updated, started, phase_started = integer(data['updatedAt']), integer(data['startedAt']), integer(data['phaseStartedAt'])
        if updated > now+30_000: codes.append('snapshot-future')
        if now-updated > 120_000 or now-fetched_at > 120_000: codes.append('snapshot-stale')
        if value['service'] != 'active' or data['phase'] == 'stopped': codes.append('service-inactive')
        if not isinstance(data['incarnation'],str) or not data['incarnation']: raise ValueError('invalid incarnation')
        cap = data['cap']
        sequence = integer(cap['sequence'])
        if type(cap['active']) is not bool or set(cap) != {'sequence','active','lastAt'}: raise ValueError('invalid cap')
        if sequence == 0:
            if cap['active'] or cap['lastAt'] is not None: raise ValueError('invalid cap')
        else: integer(cap['lastAt'])
        for name in ('follower','controller'):
            row = data['loops'][name]
            if type(row['busy']) is not bool: raise ValueError('invalid loop')
            for key in ('operationStartedAt','lastCompletedAt','lastProgressAt'):
                if row[key] is not None: integer(row[key])
            if row['busy'] and (row['operationStartedAt'] is None or now-row['operationStartedAt'] > (180_000 if name=='follower' else 1_800_000)):
                codes.append(name+'-operation-stalled')
            hold = row['hold']
            if hold is not None:
                since = integer(hold['since']);integer(hold['at'])
                if hold['reason'] not in ('dust-cap','warmup','policy','history','source'): raise ValueError('invalid hold')
                if now-since > (1_800_000 if hold['reason']=='warmup' else 300_000): codes.append(name+'-hold-'+hold['reason'])
            progress = row['lastProgressAt']
            if name=='follower' and data['phase'] in ('catchup','running') and now-(progress if progress is not None else started)>300_000:
                codes.append('follower-progress-stalled')
            if name=='controller' and mode=='anchor' and data['phase']=='running':
                result = json.loads(row['lastValue']) if row['lastValue'] is not None else None
                if result and result.get('state')=='pending' and now-(progress if progress is not None else started)>1_800_000: codes.append('controller-progress-stalled')
                if row['lastCompletedAt'] is None and not row['busy'] and now-started>1_800_000: codes.append('controller-not-started')
                if row['lastCompletedAt'] is not None and not row['busy'] and now-row['lastCompletedAt']>1_800_000: codes.append('controller-completion-stalled')
        if data['phase']=='wallet-sync' and now-phase_started>11_400_000: codes.append('wallet-sync-stalled')
        if data['phase'] in ('starting','stopping') and now-phase_started>1_800_000: codes.append('service-transition-stalled')
        coverage = data['coverage']
        if coverage is not None and coverage['head'] is not None:
            head = coverage['head'];integer(head['timestamp']);integer(head['height'])
            if data['phase']=='running' and (remote_height-head['height']>100 or now-head['timestamp']>600_000): codes.append('follower-lag')
        elif data['phase']=='running': codes.append('coverage-unavailable')
        accounting = value['accounting']
        if accounting['state'] not in ('ready','warmup','unavailable'): raise ValueError('invalid accounting state')
        if accounting['state']=='unavailable' or (accounting['state']=='warmup' and data['phase']=='running'): codes.append('accounting-unavailable')
        if accounting['state']=='ready':
            facts,head=accounting['facts'],accounting['head']
            if facts['chainTime']!=integer(head['timestamp']): raise ValueError('accounting head differs')
            if coverage is None or coverage['head'] is None:
                if data['phase'] not in ('starting','wallet-sync','catchup'): raise ValueError('accounting lacks status head')
            elif integer(head['height'])<coverage['head']['height']: raise ValueError('accounting head precedes status')
            if now-head['timestamp']>600_000 and data['phase']=='running': codes.append('accounting-stale')
            total=facts['total']
            if not isinstance(total,str) or not re.fullmatch('0|[1-9][0-9]{0,99}',total): raise ValueError('invalid accounting total')
            if type(facts['conflicts']) is not bool or type(facts['transactionCapExceeded']) is not bool: raise ValueError('invalid accounting integrity')
            integer(facts['transactions']);integer(facts['unknownReservations'])
            if facts['conflicts']: codes.append('fee-conflict')
            if facts['transactionCapExceeded']: codes.append('transaction-fee-cap')
            if int(total)>PER_DAY: codes.append('daily-fee-cap')
        return sorted(set(codes))
    except (KeyError, TypeError, ValueError, AttributeError):
        return ['snapshot-invalid']

@contextlib.contextmanager
def open_state(path):
    path=Path(path)
    parent=path.parent
    if parent.is_symlink() or parent.resolve()!=parent.absolute(): raise ValueError('unsafe watch directory')
    parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    info=parent.stat()
    if info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('watch directory must be private')
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('unsafe watch state')
    finally: os.close(fd)
    db=sqlite3.connect(path,timeout=5)
    try:
        db.execute('pragma journal_mode=WAL');db.execute('pragma synchronous=FULL')
        db.execute('create table if not exists facts (key text primary key,value text not null)')
        db.execute('create table if not exists outbox (id integer primary key,body text not null,sent integer not null default 0)')
        yield db
    finally: db.close()

def pending(db,limit=3):
    return db.execute('select id,body from outbox where sent=0 order by id limit ?',(limit,)).fetchall()

def record(db,value,codes,now):
    with db:
        def get(key, default):
            row=db.execute('select value from facts where key=?',(key,)).fetchone()
            return row[0] if row else default
        def put(key,value): db.execute('insert or replace into facts values (?,?)',(key,str(value)))
        def queue(text): db.execute('insert into outbox(body) values (?)',('Orynq Midnight: '+text,))
        if 'snapshot-invalid' not in codes and 'scope-mismatch' not in codes:
            current=value['status']['cap']['sequence'];previous=int(get('cap','0'))
            if current>previous:
                queue(f'cap episodes {previous+1}..{current}; inspect standing status');put('cap',current)
            elif current<previous: codes=sorted(set(codes+['cap-counter-regressed']))
            phase=value['status']['phase']
            if phase=='running' and not codes:
                put('bootstrap_since','')
            elif phase in ('starting','wallet-sync','catchup'):
                since=get('bootstrap_since','')
                if not since: since=str(now);put('bootstrap_since',since)
                if now-int(since)>(21_600_000 if phase=='catchup' else 11_400_000): codes=sorted(set(codes+['bootstrap-overdue']))
        current=','.join(sorted(set(codes)));previous=get('conditions','')
        if current!=previous:
            queue('alerts '+current if current else 'recovered; no current watch alerts')
            put('conditions',current)
        put('last_poll',integer(now))

def deliver(db,sender):
    for identity,body in pending(db):
        if not sender(body): return False
        with db: db.execute('update outbox set sent=1 where id=?',(identity,))
    return True

def network_request(operation,payload):
    child=subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--network',operation],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        output,_=child.communicate(input=json.dumps(payload).encode(),timeout=NETWORK_DEADLINE)
        if child.returncode!=0 or len(output)>128: return None
        return json.loads(output)
    except (subprocess.TimeoutExpired,OSError,ValueError): return None
    finally:
        if child.poll() is None: child.kill();child.wait()
        for stream in (child.stdin,child.stdout):
            if stream is not None: stream.close()

def post_alert(destination,body):
    return network_request('alert',{'destination':destination,'body':body}) is True

def send_alert(destination,body):
    request=urllib.request.Request(destination,data=json.dumps({'content':body,'allowed_mentions':{'parse':[]}}).encode(),headers={'Content-Type':'application/json','User-Agent':'orynq-midnight-watch/1.0'},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=15) as response: return 200<=response.status<300
    except (urllib.error.URLError,TimeoutError,OSError): return False

def private_json(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077 or info.st_size>BOUND: raise ValueError('unsafe private file')
        with os.fdopen(os.dup(fd),'rb') as stream: body=stream.read(BOUND+1)
        if len(body)>BOUND: raise ValueError('private file exceeds bounds')
        return json.loads(body)
    finally:os.close(fd)

def export_snapshot():
    from standing_accounting import read_accounting
    status=private_json(Path.home()/'.local/state/orynq-midnight/standing/status.json')
    try: accounting=read_accounting(Path.home()/'.local/state/orynq-midnight/standing/follower.sqlite',status['scope'],status['coverage']['head'] if status['coverage'] else None)
    except (OSError,ValueError,TypeError,KeyError,sqlite3.Error): accounting={'state':'unavailable','head':None,'facts':None}
    state=subprocess.run(['systemctl','--user','is-active','orynq-midnight-standing.service'],capture_output=True,timeout=10,check=False)
    return {'service':'active' if state.returncode==0 and state.stdout.strip()==b'active' else 'inactive','status':status,'accounting':accounting}

def remote_snapshot():
    process=subprocess.Popen(['ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=10','deci@192.168.0.131',EXPORT_COMMAND],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        with process.stdout as stream:
            output=bytearray();deadline=time.monotonic()+25
            while True:
                remaining=deadline-time.monotonic()
                if remaining<=0 or not select.select([stream],[],[],remaining)[0]: raise ValueError('snapshot deadline exceeded')
                chunk=os.read(stream.fileno(),min(65536,BOUND+1-len(output)))
                if not chunk: break
                output.extend(chunk)
                if len(output)>BOUND: raise ValueError('snapshot exceeds bounds')
        process.wait(timeout=max(0.001,deadline-time.monotonic()))
        if process.returncode!=0: raise ValueError('snapshot unavailable')
        return json.loads(output)
    finally:
        if process.poll() is None: process.kill();process.wait()

def remote_height(endpoint):
    height=network_request('rpc',{'endpoint':endpoint})
    if type(height) is not int: raise ValueError('independent RPC unavailable')
    return integer(height)

def read_remote_height(endpoint):
    from urllib.parse import urlsplit
    url=urlsplit(endpoint)
    if url.scheme!='https' or url.username or url.password or url.query or url.fragment: raise ValueError('invalid read RPC')
    headers={'Content-Type':'application/json','User-Agent':'orynq-midnight-watch/1.0'}
    def call(method,params):
        request=urllib.request.Request(endpoint,data=json.dumps(dict(jsonrpc='2.0',id=1,method=method,params=params)).encode(),headers=headers)
        with urllib.request.urlopen(request,timeout=15) as response: output=response.read(65537)
        if len(output)>65536: raise ValueError('RPC exceeds bounds')
        result=json.loads(output)
        if 'error' in result: raise ValueError('RPC refused')
        return result['result']
    head=call('chain_getFinalizedHead',[])
    if not isinstance(head,str) or not re.fullmatch('0x[a-f0-9]{64}',head): raise ValueError('invalid finalized hint')
    height=call('chain_getHeader',[head])['number']
    if not isinstance(height,str) or not re.fullmatch('0x[0-9a-fA-F]{1,12}',height): raise ValueError('invalid height')
    return integer(int(height,16))

def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--export',action='store_true');parser.add_argument('--config',type=Path);parser.add_argument('--network',choices=['rpc','alert'])
    args=parser.parse_args()
    if args.network and not args.export and args.config is None:
        try:
            payload=json.loads(sys.stdin.buffer.read(16385))
            result=read_remote_height(payload['endpoint']) if args.network=='rpc' else send_alert(payload['destination'],payload['body'])
            print(json.dumps(result));return 0
        except Exception:
            # The parent reports a bounded failure code, including malformed HTTP replies.
            return 1
    if args.network: raise ValueError('network worker arguments differ')
    if args.export and args.config is None:
        print(json.dumps(export_snapshot(),separators=(',',':')));return 0
    if args.export or args.config is None: raise ValueError('choose export or config')
    config=private_json(args.config)
    if set(config)!={'scope','mode','stateFile','rpcUrl'} or config['mode'] not in ('observe','anchor'): raise ValueError('invalid watch configuration')
    path=Path(config['stateFile'])
    if not path.is_absolute(): raise ValueError('watch state path must be absolute')
    path.parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    lock=os.open(path.with_suffix('.lock'),os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        now=int(time.time()*1000);value={};codes=[]
        try:value=remote_snapshot()
        except (OSError,ValueError,subprocess.SubprocessError):codes.append('snapshot-unavailable')
        fetched=int(time.time()*1000)
        try:height=remote_height(config['rpcUrl'])
        except (OSError,ValueError,KeyError,TypeError,urllib.error.URLError):height=0;codes.append('independent-rpc-unavailable')
        codes=sorted(set(codes+evaluate(value,config['scope'],config['mode'],int(time.time()*1000),fetched,height)))
        with open_state(path) as db:
            scope=json.dumps(config['scope'],sort_keys=True)
            saved=db.execute("select value from facts where key='scope'").fetchone()
            if saved and saved[0]!=scope: raise ValueError('watch scope changed')
            with db:db.execute("insert or ignore into facts values ('scope',?)",(scope,))
            record(db,value,codes,now)
            destination=os.environ.get('DISCORD_WEBHOOK_URL','')
            delivered=bool(destination) and deliver(db,lambda body:post_alert(destination,body))
            queued=db.execute('select count(*) from outbox where sent=0').fetchone()[0]
            print(json.dumps({'event':'standing-watch','alerts':codes,'pending':queued,'deliverySucceeded':delivered}))
            return 0 if delivered else 1
    finally:os.close(lock)

if __name__=='__main__':
    try:raise SystemExit(main())
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error,subprocess.SubprocessError):
        print('Standing watch failed before completing its durable poll',file=__import__('sys').stderr);raise SystemExit(1)
