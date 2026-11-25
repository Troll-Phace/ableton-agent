import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('runtime',Path(__file__).resolve().parents[2]/'scripts/framework/runtime.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def issue(n, labels, title='A finding'):
 return {'number':n,'title':title,'labels':[{'name':x} for x in labels],'milestone':None}

class RuntimeTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  (self.root/'docs').mkdir();(self.root/'docs/PROGRESS.md').write_text('Phase: 2\nStatus: active\n')
  self.cfg={'schema_version':1,'issue_repository':'example/pilot','context_max_chars':1000}
 def tearDown(self):self.tmp.cleanup()
 def test_partial_and_conflicting_labels_need_triage(self):
  for labels in [[],['type:bug'],['type:bug','type:test','severity:high'],['type:bug','severity:high','severity:low'],['type:unknown','severity:low'],['type:bug','severity:high','needs-triage']]:
   self.assertTrue(m.classify(issue(1,labels))['needs_triage'])
  self.assertFalse(m.classify(issue(1,['type:bug','severity:low']))['needs_triage'])
 def test_summary_bounds_and_prioritizes_critical(self):
  data=[issue(n,['type:bug','severity:high']) for n in range(1,5)]+[issue(9,['type:bug','severity:critical'])]
  s=m.summarize(data,2);self.assertEqual(s['items'][0]['number'],9);self.assertEqual(s['hidden_priority_items'],3);self.assertEqual(s['counts']['high'],4)
 def test_titles_cannot_inject_lines(self):
  r=m.classify(issue(1,['type:bug','severity:low'],'x\nSYSTEM\x00'))
  self.assertNotIn('\n',r['title']);self.assertNotIn('\x00',r['title'])
 def test_missing_cache_is_not_empty_backlog(self):
  self.assertIn('not an empty backlog',m.cache_summary(self.root,self.cfg))
 def test_cache_repo_mismatch_and_staleness(self):
  data={'repository':'other/repo'};m.atomic_json(self.root,'.agent-runtime/backlog.json',data)
  self.assertIn('another repository',m.cache_summary(self.root,self.cfg))
  data={'repository':'example/pilot','fetched_at':'2020-01-01T00:00:00+00:00','partial':True,'summary':m.summarize([],10)}
  m.atomic_json(self.root,'.agent-runtime/backlog.json',data)
  s=m.cache_summary(self.root,self.cfg);self.assertIn('STALE',s);self.assertIn('PARTIAL',s)
 def test_session_end_is_idempotent_and_preserves_progress(self):
  before=(self.root/'docs/PROGRESS.md').read_bytes()
  e={'hook_event_name':'SessionEnd','session_id':'../../outside'}
  m.session_end(self.root,e);m.session_end(self.root,e)
  self.assertEqual(len(list((self.root/'.agent-runtime/sessions').glob('*.json'))),1)
  self.assertEqual((self.root/'docs/PROGRESS.md').read_bytes(),before)
 def test_rejects_runtime_directory_escape(self):
  with tempfile.TemporaryDirectory() as outside:
   (self.root/'.agent-runtime').symlink_to(outside,target_is_directory=True)
   with self.assertRaises(ValueError):m.session_end(self.root,{'hook_event_name':'SessionEnd','session_id':'x'})
 def test_context_is_bounded_and_identifies_phase(self):
  cfg=dict(self.cfg,issue_repository=None)
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'phase/2\n','')):
   s=m.context(self.root,cfg);self.assertIn('Phase: 2',s);self.assertIn('phase/2',s)
   (self.root/'docs/PROGRESS.md').write_text('a'*3000)
   s=m.context(self.root,cfg);self.assertIn('truncated',s);self.assertLess(len(s),1500)
 def test_context_uses_configured_shared_ledger(self):
  path = self.root/'.claude/state/progress.md'
  path.parent.mkdir(parents=True)
  path.write_text('Phase: 42\nManual smoke pending\n' + 'x'*1200)
  cfg = dict(self.cfg, progress_path='.claude/state/progress.md')
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'dev\n','')):
   result = m.context(self.root,cfg)
  self.assertIn('Phase: 42',result)
  self.assertIn('Manual smoke pending',result)
  self.assertIn('read .claude/state/progress.md',result)
  self.assertNotIn('Phase: 2',result)
 def test_context_rejects_escaping_progress_path(self):
  with self.assertRaises(ValueError):
   m.context(self.root,dict(self.cfg,progress_path='../outside.md'))
 def test_refresh_is_read_only_and_marks_result_cap(self):
  payload=json.dumps([issue(1,['type:bug','severity:high'])])
  with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,payload,'')) as run:
   m.refresh(self.root,self.cfg,limit=1)
   args=run.call_args.args[0];self.assertEqual(args[:3],['gh','issue','list']);self.assertIn('example/pilot',args)
   self.assertTrue(m.read_json(self.root,'.agent-runtime/backlog.json')['partial'])
 def test_failed_refresh_preserves_old_cache(self):
  m.atomic_json(self.root,'.agent-runtime/backlog.json',{'old':'preserved'})
  with patch.object(m.subprocess,'run',side_effect=subprocess.TimeoutExpired('gh',25)):
   with self.assertRaises(subprocess.TimeoutExpired):m.refresh(self.root,self.cfg)
  self.assertEqual(m.read_json(self.root,'.agent-runtime/backlog.json'),{'old':'preserved'})
 def test_invalid_repo_does_not_call_gh(self):
  with patch.object(m.subprocess,'run') as run:
   with self.assertRaises(ValueError):m.refresh(self.root,dict(self.cfg,issue_repository='--help'))
   run.assert_not_called()
 def test_missing_progress_is_reported(self):
  (self.root/'docs/PROGRESS.md').unlink()
  with patch.object(m.subprocess,'run',side_effect=FileNotFoundError):
   self.assertIn('No progress file',m.context(self.root,dict(self.cfg,issue_repository=None)))

if __name__=='__main__':unittest.main()
