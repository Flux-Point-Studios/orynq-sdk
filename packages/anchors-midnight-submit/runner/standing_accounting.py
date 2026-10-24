"""Bounded summaries of existing authenticated follower state; no database initialization."""
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

DAY=86_400_000
TTL_MARGIN=300_000
PER_TX=10_000_000_000_000
TABLES={
    'follower_scope':['id','scope'],
    'follower_blocks':['height','hash','parent_hash','timestamp','digest','batch_indexed'],
    'follower_observations':['block_hash','extrinsic_index','tx_hash','status','fee','policy_key'],
    'follower_attempts':['tx_hash','bytes','ttl','fee','commitment','boundary_height','boundary_hash'],
    'follower_admissions':['tx_hash','policy_serial','head_height','head_hash'],
    'follower_batch_calls':['block_hash','extrinsic_index','commitment','ttl'],
    'follower_policies':['id','serial','digest','conflicted'],
}

def integer(value):
    if type(value) is not int or value<0 or value>2**53-1: raise ValueError('invalid accounting integer')
    return value

def identity(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value): raise ValueError('invalid accounting identity')
    return value

def read_accounting(path,scope,status_head):
    path=Path(path)
    if path.resolve()!=path.absolute(): raise ValueError('unsafe accounting path')
    info=path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077: raise ValueError('unsafe accounting file')
    deadline=time.monotonic()+10
    db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3)
    try:
        db.set_progress_handler(lambda: int(time.monotonic()>deadline),1000)
        db.execute('pragma query_only=on');db.execute('begin')
        if db.execute('pragma user_version').fetchone()[0]!=2: raise ValueError('unsupported accounting schema')
        tables={row[0] for row in db.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' limit 8")}
        if tables!=set(TABLES): raise ValueError('accounting tables differ')
        for table,columns in TABLES.items():
            if [row[1] for row in db.execute('pragma table_info('+table+')')]!=columns: raise ValueError('accounting columns differ')
        if any(row[0]>4096 for row in db.execute('select length(scope) from follower_scope limit 2')): raise ValueError('accounting scope exceeds bounds')
        rows=db.execute('select id,scope from follower_scope limit 2').fetchall()
        if len(rows)!=1 or rows[0][0]!=1 or json.loads(rows[0][1])!=scope: raise ValueError('accounting scope differs')
        if db.execute('select 1 from follower_policies where conflicted!=0').fetchone(): raise ValueError('accounting policy conflict')
        if db.execute("select 1 from follower_observations where status not in ('SUCCESS','PARTIAL_SUCCESS','FAILURE') or policy_key not in (0,1) limit 1").fetchone(): raise ValueError('invalid accounting observations')
        head=db.execute('select height,hash,parent_hash,timestamp from follower_blocks order by height desc limit 1').fetchone()
        floor=db.execute('select height,hash,parent_hash,timestamp from follower_blocks order by height limit 1').fetchone()
        def block(row):
            return dict(height=integer(row[0]),hash=identity(row[1]),parentHash=identity(row[2]),timestamp=integer(row[3]))
        if head is None:
            if status_head is not None or db.execute('select 1 from follower_attempts limit 1').fetchone(): raise ValueError('accounting coverage was lost')
            return dict(state='warmup',head=None,facts=None)
        top,bottom=block(head),block(floor)
        if status_head is not None:
            row=db.execute('select hash from follower_blocks where height=?',(integer(status_head['height']),)).fetchone()
            if not row or row[0]!=identity(status_head['hash']): raise ValueError('accounting no longer retains status head')
        count=db.execute('select count(*) from follower_blocks').fetchone()[0]
        if count!=top['height']-bottom['height']+1: raise ValueError('accounting interval has gaps')
        if db.execute('select 1 from follower_blocks b left join follower_blocks p on p.height=b.height-1 where b.height>? and (p.height is null or b.parent_hash!=p.hash or b.timestamp<p.timestamp) limit 1',(bottom['height'],)).fetchone(): raise ValueError('accounting history is discontinuous')
        if bottom['timestamp']>top['timestamp']-DAY: return dict(state='warmup',head=top,facts=None)
        cutoff=top['timestamp']-DAY
        # All attempts remain in this union, including financially excluded rows needed for conflicts.
        query='''
        with seen as (
          select o.tx_hash,max(o.status='PARTIAL_SUCCESS') partial,max(o.status='SUCCESS') landed
          from follower_observations o join follower_blocks b on b.hash=o.block_hash
          where b.height<=? group by o.tx_hash
        ), attempts as (
          select a.tx_hash,a.fee,a.ttl,b.timestamp,b.height,
            case when coalesce(s.partial,0)=1 then 'unknown' when coalesce(s.landed,0)=1 then 'landed'
                 when ?>a.ttl+? then 'absent' else 'unknown' end state
          from follower_attempts a left join follower_blocks b on b.height=a.boundary_height and b.hash=a.boundary_hash
          left join seen s on s.tx_hash=a.tx_hash
        )
        select o.tx_hash,o.fee,b.timestamp,0,'observed',b.height from follower_observations o join follower_blocks b on b.hash=o.block_hash
          where o.policy_key=1 and b.height<=? and b.timestamp>=?
        union all select tx_hash,fee,timestamp,ttl,state,height from attempts
        order by 1
        '''
        total=0;conflicts=False;over=False;transactions=0;unknown=0
        previous=None;amount=0;included=False;first_amount=None
        for key,fee,at,ttl,state,height in db.execute(query,(top['height'],top['timestamp'],TTL_MARGIN,top['height'],cutoff)):
            if time.monotonic()>deadline: raise ValueError('accounting scan deadline exceeded')
            identity(key)
            if not isinstance(fee,str) or not re.fullmatch('0|[1-9][0-9]{0,99}',fee): raise ValueError('invalid accounting fee')
            fee=int(fee);integer(at);integer(ttl);integer(height)
            if at>top['timestamp'] or height<bottom['height'] or height>top['height']: raise ValueError('accounting boundary differs')
            if key!=previous:
                if previous is not None and included: total+=amount;transactions+=1
                previous=key;amount=fee;included=False;first_amount=fee
            elif fee!=first_amount: conflicts=True
            amount=max(amount,fee);over |= fee>PER_TX
            included |= state in ('observed','unknown') or (state=='landed' and max(at,ttl)>=cutoff)
            unknown+=int(state=='unknown')
        if previous is not None and included: total+=amount;transactions+=1
        facts=dict(chainTime=top['timestamp'],total=str(total),conflicts=conflicts,transactionCapExceeded=over,transactions=transactions,unknownReservations=unknown)
        return dict(state='ready',head=top,facts=facts)
    finally:db.close()
