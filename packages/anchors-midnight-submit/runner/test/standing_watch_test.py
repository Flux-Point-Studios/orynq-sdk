import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import sys
sys.path.insert(0,str(Path(__file__).parents[1]))

spec = importlib.util.spec_from_file_location('standing_watch', Path(__file__).parents[1] / 'standing-watch.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
NOW = 2 * 86_400_000
SCOPE = dict(network='mainnet', genesis='01'*32, registry='02'*32, author='03'*32, policyDigest='04'*32, runtimeSpecVersion=1000300)

def snapshot():
    loop = dict(busy=False, operationStartedAt=NOW-1000, lastCompletedAt=NOW, lastProgressAt=NOW, lastValue='{"state":"idle"}', hold=None)
    return dict(service='active', status=dict(format='orynq-midnight-standing-status/v1', scope=SCOPE.copy(), mode='anchor', incarnation='fixture', startedAt=NOW-1800000, updatedAt=NOW, phase='running',
        phaseStartedAt=NOW-1800000, loops=dict(follower=loop.copy(), controller=loop.copy()), cap=dict(sequence=0,active=False,lastAt=None),
        coverage=dict(floor=dict(height=1,hash='05'*32,parentHash='00'*32,timestamp=NOW-86400001),head=dict(height=14402,hash='06'*32,parentHash='07'*32,timestamp=NOW),earliestAttempt=None,replay=None)),
        accounting=dict(state='ready',head=dict(height=14402,hash='06'*32,timestamp=NOW),facts=dict(chainTime=NOW,total='0',conflicts=False,transactionCapExceeded=False,transactions=0,unknownReservations=0)))

class StandingWatchTests(unittest.TestCase):
    def test_healthy_snapshot_and_scope(self):
        self.assertEqual(watch.evaluate(snapshot(), SCOPE, 'anchor', NOW, NOW, 14402), [])
        value=snapshot();value['status']['scope']['author']='ff'*32
        self.assertIn('scope-mismatch',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))

    def test_stalled_controller_is_not_masked_by_follower(self):
        value=snapshot();value['status']['loops']['controller'].update(busy=True,operationStartedAt=NOW-1800001)
        self.assertIn('controller-operation-stalled',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        value['status']['loops']['controller'].update(busy=False,lastValue='{"state":"pending"}',lastProgressAt=NOW-1800001)
        self.assertIn('controller-progress-stalled',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        value=snapshot();value['status']['loops']['controller'].update(lastCompletedAt=NOW-1800001)
        self.assertIn('controller-completion-stalled',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))

    def test_freshness_service_and_independent_head(self):
        value=snapshot();value['status']['updatedAt']=NOW-120001
        self.assertIn('snapshot-stale',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        value=snapshot();value['service']='inactive'
        self.assertIn('service-inactive',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        self.assertIn('follower-lag',watch.evaluate(snapshot(),SCOPE,'anchor',NOW,NOW,15003))
        value=snapshot();value['status']['updatedAt']=NOW+30001
        self.assertIn('snapshot-future',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))

    def test_sync_heartbeats_and_fresh_shutdown_have_their_own_phase_age(self):
        value=snapshot();value['status'].update(phase='wallet-sync',startedAt=NOW-180000,phaseStartedAt=NOW-180000)
        self.assertEqual(watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402),[])
        value['status'].update(phase='stopping',startedAt=NOW-86400000,phaseStartedAt=NOW)
        self.assertEqual(watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402),[])

    def test_retained_accounting_is_usable_during_sync_before_the_first_status_head(self):
        value=snapshot();value['status'].update(phase='wallet-sync',coverage=None)
        self.assertEqual(watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402),[])
        value['status']['phase']='running'
        self.assertEqual(watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402),['snapshot-invalid'])

    def test_independent_summary_integrity_and_fee_caps(self):
        value=snapshot();value['accounting']['facts'].update(conflicts=True,transactionCapExceeded=True,total='30000000000000')
        codes=watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402)
        self.assertIn('fee-conflict',codes);self.assertIn('transaction-fee-cap',codes)
        value['accounting']['facts']['total']='110000000000000'
        self.assertIn('daily-fee-cap',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))

    def test_missing_malformed_accounting_fails_closed(self):
        value=snapshot();value['accounting']['state']='unavailable'
        self.assertIn('accounting-unavailable',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        value=snapshot();value['accounting']['facts']['total']='1e3'
        self.assertIn('snapshot-invalid',watch.evaluate(value,SCOPE,'anchor',NOW,NOW,14402))
        self.assertEqual(watch.evaluate({},SCOPE,'anchor',NOW,NOW,0),['snapshot-invalid'])

    def test_cap_episodes_survive_missed_poll_restart_and_failed_delivery(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'watch.sqlite'
            with watch.open_state(path) as db:
                watch.record(db,snapshot(),[],NOW)
            value=snapshot();value['status']['cap']=dict(sequence=2,active=False,lastAt=NOW)
            value['status']['incarnation']='after-restart'
            with watch.open_state(path) as db:
                watch.record(db,value,[],NOW)
                self.assertEqual(len(watch.pending(db)),1)
                self.assertIn('cap episodes 1..2',watch.pending(db)[0][1])
                self.assertFalse(watch.deliver(db,lambda _:False));self.assertEqual(len(watch.pending(db)),1)
            with watch.open_state(path) as db:
                watch.record(db,value,[],NOW+1)
                self.assertEqual(len(watch.pending(db)),1)
                self.assertTrue(watch.deliver(db,lambda _:True));self.assertEqual(watch.pending(db),[])
                watch.record(db,value,['service-inactive'],NOW+2)
                self.assertEqual(len(watch.pending(db)),1)
                watch.record(db,value,[],NOW+3)
                self.assertEqual(len(watch.pending(db)),2)
                self.assertIn('recovered',watch.pending(db)[1][1])

    def test_cap_counter_rollback_and_bad_snapshot_do_not_erase_history(self):
        with tempfile.TemporaryDirectory() as root, watch.open_state(Path(root)/'watch.sqlite') as db:
            value=snapshot();value['status']['cap']=dict(sequence=3,active=True,lastAt=NOW)
            watch.record(db,value,[],NOW)
            watch.deliver(db,lambda _:True)
            watch.record(db,{},['snapshot-invalid'],NOW+1)
            watch.record(db,snapshot(),[],NOW+2)
            self.assertTrue(any('cap-counter-regressed' in row[1] for row in watch.pending(db)))

    def test_repeated_fresh_startups_do_not_reset_durable_bootstrap_deadline(self):
        with tempfile.TemporaryDirectory() as root, watch.open_state(Path(root)/'watch.sqlite') as db:
            value=snapshot();value['status']['phase']='wallet-sync'
            watch.record(db,value,[],NOW)
            value['status'].update(incarnation='new-process',startedAt=NOW+11400001,updatedAt=NOW+11400001)
            watch.record(db,value,[],NOW+11400001)
            self.assertTrue(any('bootstrap-overdue' in row[1] for row in watch.pending(db)))
            watch.record(db,snapshot(),[],NOW+11400002)
            watch.record(db,value,[],NOW+11400003)
            self.assertEqual(db.execute("select value from facts where key='bootstrap_since'").fetchone()[0],str(NOW+11400003))

    def test_http_429_is_a_failed_delivery_and_never_logs_destination(self):
        import http.server
        import threading
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                self.send_response(429);self.end_headers();self.wfile.write(b'private destination')
            def log_message(self,*args): pass
        server=http.server.HTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:self.assertFalse(watch.post_alert(f'http://127.0.0.1:{server.server_port}/secret','fixture'))
        finally:server.shutdown();server.server_close();thread.join()

    def test_remote_snapshot_stops_an_oversized_live_child_without_waiting_for_exit(self):
        import subprocess
        import sys
        import time
        from unittest.mock import patch
        original=subprocess.Popen
        def child(*args,**kwargs):
            return original([sys.executable,'-c',f'import sys,time;sys.stdout.buffer.write(b"x"*{watch.BOUND+1});sys.stdout.flush();time.sleep(3)'],**kwargs)
        started=time.monotonic()
        with patch.object(watch.subprocess,'Popen',child),self.assertRaises(ValueError):watch.remote_snapshot()
        self.assertLess(time.monotonic()-started,2)

    def test_auxiliary_rpc_failure_cannot_prevent_alert_outbox_progress(self):
        from unittest.mock import patch
        with patch.object(watch,'network_request',return_value=None) as request,self.assertRaises(ValueError):
            watch.remote_height('https://rpc.example')
        request.assert_called_once_with('rpc',{'endpoint':'https://rpc.example'})

    def test_network_worker_has_a_whole_exchange_deadline_and_sanitizes_failures(self):
        import subprocess
        from unittest.mock import patch
        with patch.object(watch.subprocess,'Popen') as spawn:
            child=spawn.return_value;child.communicate.side_effect=subprocess.TimeoutExpired('fixture',20);child.poll.return_value=None
            self.assertIsNone(watch.network_request('rpc',{'endpoint':'https://rpc.example'}))
            self.assertEqual(child.communicate.call_args.kwargs['timeout'],20)
            child.kill.assert_called_once();child.wait.assert_called_once()

    def test_a_real_stalled_network_child_is_killed_by_the_parent_deadline(self):
        import subprocess
        import sys
        import time
        from unittest.mock import patch
        original=subprocess.Popen;children=[]
        def child(*args,**kwargs):
            process=original([sys.executable,'-c','import time;time.sleep(3)'],**kwargs);children.append(process);return process
        started=time.monotonic()
        with patch.object(watch,'NETWORK_DEADLINE',0.2),patch.object(watch.subprocess,'Popen',child):
            self.assertIsNone(watch.network_request('rpc',{'endpoint':'https://rpc.example'}))
        self.assertLess(time.monotonic()-started,2);self.assertLess(children[0].returncode,0)
        self.assertTrue(children[0].stdin.closed);self.assertTrue(children[0].stdout.closed)

if __name__=='__main__':unittest.main()
