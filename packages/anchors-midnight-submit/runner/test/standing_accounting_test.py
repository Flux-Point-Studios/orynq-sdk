import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('standing_accounting',Path(__file__).parents[1]/'standing_accounting.py')
accounting=importlib.util.module_from_spec(spec);spec.loader.exec_module(accounting)
SCOPE=dict(network='preprod',genesis='01'*32,registry='02'*32,author='03'*32,policyDigest='04'*32,runtimeSpecVersion=1000300)
NOW=2*86400000
SCHEMA='''
pragma user_version=2;
create table follower_scope(id integer primary key,scope text);
create table follower_blocks(height integer primary key,hash text,parent_hash text,timestamp integer,digest text,batch_indexed integer);
create table follower_observations(block_hash text,extrinsic_index integer,tx_hash text,status text,fee text,policy_key integer);
create table follower_attempts(tx_hash text primary key,bytes blob,ttl integer,fee text,commitment text,boundary_height integer,boundary_hash text);
create table follower_admissions(tx_hash text,policy_serial integer,head_height integer,head_hash text);
create table follower_batch_calls(block_hash text,extrinsic_index integer,commitment text,ttl integer);
create table follower_policies(id integer primary key,serial integer,digest text,conflicted integer);
'''

class AccountingTests(unittest.TestCase):
    def setUp(self):
        self.scratch=tempfile.TemporaryDirectory();self.addCleanup(self.scratch.cleanup)
        self.path=Path(self.scratch.name)/'follower.sqlite'
        self.db=sqlite3.connect(self.path);self.addCleanup(self.db.close);self.db.executescript(SCHEMA)
        os.chmod(self.path,0o600)
        self.db.execute('insert into follower_scope values (1,?)',(json.dumps(SCOPE),))
        self.db.execute('insert into follower_policies values (1,1,?,0)',('08'*32,))
        self.db.executemany('insert into follower_blocks values (?,?,?,?,?,1)',[(1,'05'*32,'00'*32,NOW-86400001,'09'*32),(2,'06'*32,'05'*32,NOW,'09'*32)])
        self.db.commit();self.status_head=dict(height=2,hash='06'*32)
    def attempt(self,n,fee='10000000000000',ttl=1):
        self.db.execute('insert into follower_attempts values (?,X\'00\',?,?,?,1,?)',(f'{n:064x}',ttl,fee,'07'*32,'05'*32));self.db.commit()
    def observed(self,n,fee='10000000000000',status='SUCCESS',index=0):
        self.db.execute('insert into follower_observations values (?,?,?,?,?,1)',('06'*32,index,f'{n:064x}',status,fee));self.db.commit()
    def read(self):return accounting.read_accounting(self.path,SCOPE,self.status_head)
    def test_large_absent_history_stays_bounded_and_all_unknowns_are_retained(self):
        self.db.executemany('insert into follower_attempts values (?,X\'00\',1,?,?,1,?)',[(f'{n:064x}','10000000000000','07'*32,'05'*32) for n in range(15000)])
        self.db.commit();result=self.read()
        self.assertEqual(result['facts']['total'],'0');self.assertLess(len(json.dumps(result)),2048)
        self.attempt(15000,ttl=NOW);self.assertEqual(self.read()['facts']['total'],'10000000000000')
    def test_partial_has_priority_and_retains_an_old_reservation(self):
        self.attempt(1);self.observed(1,status='PARTIAL_SUCCESS');self.observed(1,status='SUCCESS',index=1)
        self.db.execute("update follower_observations set block_hash=?",('05'*32,));self.db.commit()
        self.assertEqual(self.read()['facts']['total'],'10000000000000')
        self.assertEqual(self.read()['facts']['unknownReservations'],1)
    def test_conflicting_fees_use_the_maximum_and_preserve_integrity_alert(self):
        self.attempt(1,fee='20000000000000');self.observed(1)
        result=self.read()['facts'];self.assertEqual(result['total'],'20000000000000')
        self.assertTrue(result['conflicts']);self.assertTrue(result['transactionCapExceeded'])
    def test_failed_observation_does_not_release_an_unknown_reservation(self):
        self.attempt(1,ttl=NOW);self.observed(1,status='FAILURE')
        self.assertEqual(self.read()['facts']['unknownReservations'],1)
    def test_rolling_boundary_and_later_landed_ttl_are_inclusive(self):
        self.db.execute('update follower_blocks set timestamp=? where height=1',(NOW-86400000,));self.db.commit()
        self.attempt(1,ttl=NOW-86400000);self.observed(1)
        self.assertEqual(self.read()['facts']['total'],'10000000000000')
    def test_scope_status_head_schema_and_missing_boundary_are_refused(self):
        with self.assertRaises(ValueError):accounting.read_accounting(self.path,{**SCOPE,'author':'ff'*32},self.status_head)
        with self.assertRaises(ValueError):accounting.read_accounting(self.path,SCOPE,dict(height=2,hash='ff'*32))
        self.attempt(1);self.db.execute("update follower_attempts set boundary_hash=?",('ff'*32,));self.db.commit()
        with self.assertRaises(ValueError):self.read()
        self.db.execute('pragma user_version=99');self.db.commit()
        with self.assertRaises(ValueError):self.read()
    def test_read_only_snapshot_can_advance_beyond_the_last_status_head(self):
        self.status_head=dict(height=1,hash='05'*32)
        before=self.path.read_bytes();result=self.read();self.assertEqual(result['head']['height'],2);self.assertEqual(before,self.path.read_bytes())
    def test_incomplete_day_is_warmup_and_gaps_are_refused(self):
        self.db.execute('update follower_blocks set timestamp=? where height=1',(NOW-1,));self.db.commit()
        self.assertEqual(self.read()['state'],'warmup')
        self.db.execute('update follower_blocks set height=3 where height=2');self.db.commit();self.status_head=dict(height=3,hash='06'*32)
        with self.assertRaises(ValueError):self.read()
    def test_corrupt_fees_and_expired_partial_reservations_do_not_disappear(self):
        self.attempt(1,fee='-1')
        with self.assertRaises(ValueError):self.read()

if __name__=='__main__':unittest.main()
