import json
import os
import tempfile
import threading
import time
import unittest

import app as hj


class HackJudgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        hj.DB_PATH = os.path.join(self.tmp.name, "test.db")
        hj.init_db()
        hj.app.config["TESTING"] = True
        self.client = hj.app.test_client()

    def tearDown(self):
        import gc
        gc.collect()
        try:
            self.tmp.cleanup()
        except PermissionError:
            pass

    def test_health_and_empty_list(self):
        self.assertEqual(self.client.get('/api/health').status_code, 200)
        self.assertEqual(self.client.get('/api/hackathons').json, [])

    def test_create_hackathon_requires_weights_total_100(self):
        payload = {"name": "Test", "criteria": [{"name": "Build", "description": "Quality", "weight": 40}]}
        response = self.client.post('/api/hackathons', json=payload)
        self.assertEqual(response.status_code, 400)
        payload["criteria"] = [{"name": "Build", "description": "Quality", "weight": 100}]
        response = self.client.post('/api/hackathons', json=payload)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.json["criteria"][0]["weight"], 100)

    def test_override_requires_reason_and_records_audit(self):
        h = self.client.post('/api/hackathons', json={"name":"Test", "criteria":[{"name":"Build","description":"Quality","weight":100}]}).json
        with hj.db() as con:
            cur = con.execute("INSERT INTO submissions(hackathon_id,team_name,project_name,github_url,status,score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", (h['id'], 'Team', 'App', 'https://github.com/example/app', 'EVALUATED', 65.0, hj.now_iso(), hj.now_iso()))
            sid = cur.lastrowid
        bad = self.client.post(f'/api/submissions/{sid}/override', json={"score":80})
        self.assertEqual(bad.status_code, 400)
        good = self.client.post(f'/api/submissions/{sid}/override', json={"score":82.5,"reason":"Human review found additional evidence"})
        self.assertEqual(good.status_code, 200)
        self.assertEqual(good.json['score'], 82.5)
        detail = self.client.get(f'/api/submissions/{sid}').json
        self.assertEqual(detail['audit_log'][0]['action'], 'score_override')

    def test_delete_hackathon(self):
        h = self.client.post('/api/hackathons', json={"name":"ToDelete", "criteria":[{"name":"Build","description":"Quality","weight":100}]}).json
        hid = h['id']
        del_resp = self.client.delete(f'/api/hackathons/{hid}')
        self.assertEqual(del_resp.status_code, 200)
        get_resp = self.client.get(f'/api/hackathons/{hid}')
        self.assertEqual(get_resp.status_code, 404)

    def test_github_url_validation(self):
        with self.assertRaises(ValueError):
            hj.github_repo_from_url('https://evil.example/github.com/owner/repo')
        self.assertEqual(hj.github_repo_from_url('https://github.com/owner/repo.git'), ('owner','repo'))

    def test_inspect_demo_empty(self):
        res = hj.inspect_demo("")
        self.assertFalse(res['provided'])
        self.assertIsNone(res['reachable'])

    def test_inspect_demo_invalid_url(self):
        res = hj.inspect_demo("ftp://not-http.example.com")
        self.assertTrue(res['provided'])
        self.assertFalse(res['reachable'])

    def test_student_portal_and_submit_redirect(self):
        # When no hackathon exists
        resp = self.client.get('/submit')
        self.assertEqual(resp.status_code, 404)
        resp_join = self.client.get('/join/999')
        self.assertEqual(resp_join.status_code, 404)

        # Create a hackathon
        h = self.client.post('/api/hackathons', json={
            "name": "Freshers Hack 2026",
            "track": "Web Dev",
            "description": "First-year student hackathon",
            "criteria": [{"name": "Execution", "description": "Working code", "weight": 100}]
        }).json
        hid = h['id']

        # Check /join/<hid> renders successfully with hackathon title
        resp = self.client.get(f'/join/{hid}')
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"Freshers Hack 2026", resp.data)
        self.assertIn(b"Student Submission Portal", resp.data)

        # Check /submit redirects to /join/<latest_id>
        resp_sub = self.client.get('/submit')
        self.assertEqual(resp_sub.status_code, 302)
        self.assertTrue(resp_sub.headers['Location'].endswith(f'/join/{hid}'))

    def test_keep_alive_pinger(self):
        # When no env var is set
        os.environ.pop("RENDER_EXTERNAL_URL", None)
        os.environ.pop("APP_URL", None)
        self.assertIsNone(hj.start_keep_alive_pinger())

        # When RENDER_EXTERNAL_URL is set
        os.environ["RENDER_EXTERNAL_URL"] = "https://example.onrender.com"
        worker = hj.start_keep_alive_pinger(initial_delay=9999, interval=9999)
        self.assertIsNotNone(worker)
        self.assertTrue(worker.is_alive())
        self.assertTrue(worker.daemon)
        os.environ.pop("RENDER_EXTERNAL_URL", None)

    def test_reevaluate_submission_endpoint(self):
        h = self.client.post('/api/hackathons', json={"name": "RevalTest", "criteria": [{"name": "Build", "description": "Quality", "weight": 100}]}).json
        hid = h['id']
        with hj.db() as con:
            cur = con.execute(
                "INSERT INTO submissions(hackathon_id,team_name,project_name,github_url,status,score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (hid, 'Team Alpha', 'Project Alpha', 'https://github.com/example/alpha', 'ASSESSMENT_ERROR', None, hj.now_iso(), hj.now_iso())
            )
            sid = cur.lastrowid

        # Trigger re-evaluation
        resp = self.client.post(f'/api/submissions/{sid}/reevaluate', json={"actor": "Judge Sarah", "reason": "Retrying after API hiccup"})
        self.assertIn(resp.status_code, (200, 202))
        
        # Verify status is reset to ANALYZING and audit log was recorded
        detail = self.client.get(f'/api/submissions/{sid}').json
        self.assertEqual(detail['status'], 'ANALYZING')
        self.assertTrue(any(a['action'] == 'reevaluate' for a in detail['audit_log']))

    def test_hackathon_leaderboard(self):
        h = self.client.post('/api/hackathons', json={"name": "RankTest", "criteria": [{"name": "Build", "description": "Quality", "weight": 100}]}).json
        hid = h['id']
        with hj.db() as con:
            con.execute("INSERT INTO submissions(hackathon_id,team_name,project_name,github_url,status,score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        (hid, 'Team Low', 'App 1', 'https://github.com/example/1', 'EVALUATED', 60.0, hj.now_iso(), hj.now_iso()))
            con.execute("INSERT INTO submissions(hackathon_id,team_name,project_name,github_url,status,score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        (hid, 'Team High', 'App 2', 'https://github.com/example/2', 'EVALUATED', 95.0, hj.now_iso(), hj.now_iso()))

        resp = self.client.get(f'/api/hackathons/{hid}/leaderboard')
        self.assertEqual(resp.status_code, 200)
        board = resp.json
        self.assertEqual(len(board), 2)
        # Highest score should be rank #1
        self.assertEqual(board[0]['team_name'], 'Team High')
        self.assertEqual(board[0]['rank'], 1)
        self.assertEqual(board[1]['team_name'], 'Team Low')
        self.assertEqual(board[1]['rank'], 2)

    def test_ast_analysis(self):
        py_snippets = [
            {
                "path": "app.py",
                "content": """
@app.route('/api/users')
def get_users():
    return []

class UserModel(db.Model):
    pass

def unfinished_helper():
    pass
"""
            }
        ]
        res = hj.run_ast_analysis(py_snippets)
        self.assertEqual(res['python_files_analyzed'], 1)
        self.assertTrue(any('get_users' in r for r in res['ast_routes']))
        self.assertIn('UserModel', res['ast_models'])
        self.assertIn('unfinished_helper', res['ast_stubs'])

    def test_code_similarity_detection(self):
        snippets_a = [{"path": "main.py", "content": "def calculate_matrix():\n    total = 0\n    for i in range(100):\n        total += i\n    return total"}]
        snippets_b = [{"path": "copied.py", "content": "# Copy\ndef calculate_matrix():\n    total = 0\n    for i in range(100):\n        total += i\n    return total"}]
        snippets_c = [{"path": "other.py", "content": "import flask\napp = flask.Flask(__name__)\nprint('totally different')"}]

        fp_a = hj.compute_code_fingerprint(snippets_a)
        fp_b = hj.compute_code_fingerprint(snippets_b)
        fp_c = hj.compute_code_fingerprint(snippets_c)

        self.assertTrue(len(fp_a) > 0)
        # Compare a and b: should be 100% identical token shingle similarity
        inter = len(fp_a.intersection(fp_b))
        union = len(fp_a.union(fp_b))
        sim_ab = inter / union if union else 0
        self.assertGreater(sim_ab, 0.9)

        # Compare a and c: should have near zero similarity
        inter_c = len(fp_a.intersection(fp_c))
        union_c = len(fp_a.union(fp_c))
        sim_ac = inter_c / union_c if union_c else 0
        self.assertLess(sim_ac, 0.2)

    def test_parallel_task_evaluation(self):
        h = self.client.post('/api/hackathons', json={
            "name": "ParallelTest",
            "criteria": [{"name": "Build", "description": "Quality", "weight": 100}]
        }).json
        hid = h['id']

        # Pre-insert 4 submissions
        sids = []
        for i in range(4):
            with hj.db() as con:
                cur = con.execute(
                    "INSERT INTO submissions(hackathon_id,team_name,project_name,github_url,status,score,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (hid, f"Team {i}", f"Proj {i}", f"https://github.com/example/{i}", "PENDING", None, hj.now_iso(), hj.now_iso())
                )
                sids.append(cur.lastrowid)

        active_count = 0
        max_seen_concurrency = 0
        counter_lock = threading.Lock()
        eval_completed_event = threading.Event()
        completed_sids = set()

        orig_run_eval = hj.run_evaluation_task

        def mock_run_eval(sub_id, force_refresh=False):
            nonlocal active_count, max_seen_concurrency
            with counter_lock:
                active_count += 1
                if active_count > max_seen_concurrency:
                    max_seen_concurrency = active_count
            # Hold thread to simulate parallel network/AI operations
            time.sleep(0.12)
            with hj.db() as con:
                con.execute("UPDATE submissions SET status='EVALUATED', score=90.0 WHERE id=?", (sub_id,))
                row = con.execute("SELECT * FROM submissions WHERE id=?", (sub_id,)).fetchone()
            with counter_lock:
                active_count -= 1
                completed_sids.add(sub_id)
                if len(completed_sids) == 4:
                    eval_completed_event.set()
            return row, None

        hj.run_evaluation_task = mock_run_eval
        try:
            # Enqueue all 4 tasks
            for sid in sids:
                hj.enqueue_evaluation_task(sid)

            # Wait for all 4 to finish
            done = eval_completed_event.wait(timeout=4.0)
            self.assertTrue(done, "All 4 evaluations should finish within timeout")
            self.assertEqual(len(completed_sids), 4)
            # Sequential queue would yield max_concurrency == 1; parallel worker yields >= 2
            self.assertGreaterEqual(
                max_seen_concurrency, 2,
                f"Expected parallel evaluation concurrency >= 2, got {max_seen_concurrency}"
            )
        finally:
            hj.run_evaluation_task = orig_run_eval

    def test_student_roll_number_and_submission_limits(self):
        h = self.client.post('/api/hackathons', json={
            "name": "RollLimitTest",
            "criteria": [{"name": "Build", "description": "Quality", "weight": 100}]
        }).json
        hid = h['id']
        roll = "21BCS1042"

        # Attempt 1, 2, 3 should succeed
        for i in range(1, 4):
            resp = self.client.post('/api/submissions', json={
                "hackathon_id": hid,
                "team_name": "Team Devs",
                "project_name": f"App V{i}",
                "roll_number": roll,
                "github_url": f"https://github.com/example/app{i}",
                "sync": False
            })
            self.assertEqual(resp.status_code, 202)
            self.assertEqual(resp.json["roll_number"], roll)
            self.assertEqual(resp.json["attempt_number"], i)
            # Mark finished so next attempt is not considered in-flight
            with hj.db() as con:
                con.execute("UPDATE submissions SET status='EVALUATED', score=? WHERE id=?", (70.0 + i, resp.json["id"]))

        # Attempt 4 should be rejected with 429 quota exceeded
        resp4 = self.client.post('/api/submissions', json={
            "hackathon_id": hid,
            "team_name": "Team Devs",
            "project_name": "App V4",
            "roll_number": roll,
            "github_url": "https://github.com/example/app4",
            "sync": False
        })
        self.assertEqual(resp4.status_code, 429)
        self.assertIn("limit reached", resp4.json["error"].lower())

        # Check /api/hackathons/<id>/students/<roll> endpoint
        student_info = self.client.get(f'/api/hackathons/{hid}/students/{roll}').json
        self.assertEqual(student_info["attempts_used"], 3)
        self.assertEqual(student_info["remaining_attempts"], 0)

    def test_higher_score_retention_and_rejection_of_lower_score(self):
        h = self.client.post('/api/hackathons', json={
            "name": "ScoreDedupeTest",
            "criteria": [{"name": "Build", "description": "Quality", "weight": 100}]
        }).json
        hid = h['id']
        roll = "22BCS2099"

        orig_ai = hj.ai_assessment
        orig_fetch = hj.fetch_evidence_and_demo
        try:
            hj.fetch_evidence_and_demo = lambda g, d, force_refresh=False: ({"selected_files": []}, {"reachable": True})

            # Attempt 1: scores 75.0
            hj.ai_assessment = lambda hack, sub, ev, demo: ({"overall_score": 75.0, "summary": "Good project"}, "ai")
            resp1 = self.client.post('/api/submissions', json={
                "hackathon_id": hid, "team_name": "Alpha", "project_name": "Proj 1",
                "roll_number": roll, "github_url": "https://github.com/example/p1", "sync": True
            })
            self.assertEqual(resp1.status_code, 201)
            sub1_id = resp1.json["id"]
            self.assertEqual(resp1.json["status"], "EVALUATED")
            self.assertEqual(resp1.json["score"], 75.0)

            # Leaderboard should have 1 entry with score 75.0
            board = self.client.get(f'/api/hackathons/{hid}/leaderboard').json
            self.assertEqual(len(board), 1)
            self.assertEqual(board[0]["id"], sub1_id)
            self.assertEqual(board[0]["score"], 75.0)

            # Attempt 2: scores 88.0 (HIGHER score)
            hj.ai_assessment = lambda hack, sub, ev, demo: ({"overall_score": 88.0, "summary": "Great upgrade"}, "ai")
            resp2 = self.client.post('/api/submissions', json={
                "hackathon_id": hid, "team_name": "Alpha", "project_name": "Proj 2",
                "roll_number": roll, "github_url": "https://github.com/example/p2", "sync": True
            })
            self.assertEqual(resp2.status_code, 201)
            sub2_id = resp2.json["id"]
            self.assertEqual(resp2.json["status"], "EVALUATED")
            self.assertEqual(resp2.json["score"], 88.0)

            # Sub 1 should now be REJECTED (superseded)
            sub1_detail = self.client.get(f'/api/submissions/{sub1_id}').json
            self.assertEqual(sub1_detail["status"], "REJECTED")

            # Leaderboard should have ONLY 1 entry: Sub 2 with score 88.0
            board = self.client.get(f'/api/hackathons/{hid}/leaderboard').json
            self.assertEqual(len(board), 1)
            self.assertEqual(board[0]["id"], sub2_id)
            self.assertEqual(board[0]["score"], 88.0)

            # Attempt 3: scores 62.0 (LOWER score)
            hj.ai_assessment = lambda hack, sub, ev, demo: ({"overall_score": 62.0, "summary": "Downgrade"}, "ai")
            resp3 = self.client.post('/api/submissions', json={
                "hackathon_id": hid, "team_name": "Alpha", "project_name": "Proj 3",
                "roll_number": roll, "github_url": "https://github.com/example/p3", "sync": True
            })
            self.assertEqual(resp3.status_code, 201)
            sub3_id = resp3.json["id"]
            # Sub 3 should be REJECTED because 62.0 < 88.0
            self.assertEqual(resp3.json["status"], "REJECTED")
            self.assertEqual(resp3.json["score"], 62.0)

            # Sub 2 should STILL be EVALUATED with score 88.0
            sub2_detail = self.client.get(f'/api/submissions/{sub2_id}').json
            self.assertEqual(sub2_detail["status"], "EVALUATED")

            # Leaderboard STILL has ONLY 1 entry: Sub 2 (highest score 88.0)
            board = self.client.get(f'/api/hackathons/{hid}/leaderboard').json
            self.assertEqual(len(board), 1)
            self.assertEqual(board[0]["id"], sub2_id)
            self.assertEqual(board[0]["score"], 88.0)
        finally:
            hj.ai_assessment = orig_ai
            hj.fetch_evidence_and_demo = orig_fetch

    def test_root_url_redirects_to_student_portal_preventing_url_hijack(self):
        # 1. When no hackathon exists, GET / redirects to /submit which returns 404
        resp = self.client.get('/', follow_redirects=False)
        self.assertEqual(resp.status_code, 404)

        # 2. When a hackathon exists, GET / redirects to /join/<id>
        h = self.client.post('/api/hackathons', json={
            "name": "SecHack", "criteria": [{"name": "C1", "description": "D1", "weight": 100}]
        }).json
        hid = h['id']

        resp2 = self.client.get('/', follow_redirects=False)
        self.assertEqual(resp2.status_code, 302)
        self.assertTrue(resp2.headers['Location'].endswith(f'/join/{hid}'))

    def test_admin_dashboard_passkey_gatekeeper(self):
        # Without passkey, GET /admin renders the passkey login page
        resp = self.client.get('/admin', headers={"X-Force-Auth-Check": "true"})
        self.assertEqual(resp.status_code, 200)
        self.assertIn(b"Administrative Access", resp.data)
        self.assertIn(b"Organizer Passkey", resp.data)

        # Invalid login
        bad_login = self.client.post('/admin/login', json={"key": "wrong_key"})
        self.assertEqual(bad_login.status_code, 401)

        # Valid login
        good_login = self.client.post('/admin/login', json={"key": hj.ADMIN_ACCESS_KEY})
        self.assertEqual(good_login.status_code, 200)
        self.assertIn("admin_session", good_login.headers.get("Set-Cookie", ""))

        # With session cookie or X-Admin-Key, GET /admin renders index.html
        auth_resp = self.client.get('/admin', headers={"X-Admin-Key": hj.ADMIN_ACCESS_KEY})
        self.assertEqual(auth_resp.status_code, 200)
        self.assertIn(b"Command Center", auth_resp.data)

    def test_destructive_admin_endpoints_require_authorization(self):
        h = self.client.post('/api/hackathons', json={
            "name": "AuthTest", "criteria": [{"name": "Build", "description": "Q", "weight": 100}]
        }).json
        hid = h['id']

        # Unauthorized calls with X-Force-Auth-Check: true
        headers_unauth = {"X-Force-Auth-Check": "true"}
        del_resp = self.client.delete(f'/api/hackathons/{hid}', headers=headers_unauth)
        self.assertEqual(del_resp.status_code, 401)

        post_hack = self.client.post('/api/hackathons', json={"name": "No"}, headers=headers_unauth)
        self.assertEqual(post_hack.status_code, 401)

        override = self.client.post('/api/submissions/1/override', json={"score": 50, "reason": "X"}, headers=headers_unauth)
        self.assertEqual(override.status_code, 401)

        reeval = self.client.post('/api/submissions/1/reevaluate', headers=headers_unauth)
        self.assertEqual(reeval.status_code, 401)

        # Authorized call with X-Admin-Key succeeds
        headers_auth = {"X-Admin-Key": hj.ADMIN_ACCESS_KEY}
        del_auth = self.client.delete(f'/api/hackathons/{hid}', headers=headers_auth)
        self.assertEqual(del_auth.status_code, 200)

    def test_security_headers_present(self):
        resp = self.client.get('/api/health')
        self.assertEqual(resp.headers.get("X-Frame-Options"), "SAMEORIGIN")
        self.assertEqual(resp.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin")

    def test_ssrf_protection_blocks_private_and_loopback_ips(self):
        # Loopback URL
        res_loopback = hj.inspect_demo("http://127.0.0.1:80/api")
        self.assertFalse(res_loopback["reachable"])
        self.assertIn("blocked", res_loopback["message"].lower())

        # Cloud metadata service URL
        res_meta = hj.inspect_demo("http://169.254.169.254/latest/meta-data")
        self.assertFalse(res_meta["reachable"])
        self.assertIn("blocked", res_meta["message"].lower())

    def test_student_access_leaderboard_without_submission(self):
        # Create hackathon
        h = self.client.post('/api/hackathons', json={
            "name": "OpenLeaderboardHack", "criteria": [{"name": "C", "description": "D", "weight": 100}]
        }).json
        hid = h['id']

        # 1. Access /join/<id>/leaderboard directly without submitting
        resp_lb = self.client.get(f'/join/{hid}/leaderboard')
        self.assertEqual(resp_lb.status_code, 200)
        self.assertIn(b"Leaderboard", resp_lb.data)
        self.assertIn(b"Live Leaderboard", resp_lb.data)

        # 2. Access /leaderboard global redirect
        resp_redir = self.client.get('/leaderboard')
        self.assertEqual(resp_redir.status_code, 302)
        self.assertTrue(resp_redir.headers['Location'].endswith(f'/join/{hid}/leaderboard'))

        # 3. Direct API access to leaderboard data without submitting or authentication
        api_lb = self.client.get(f'/api/hackathons/{hid}/leaderboard')
        self.assertEqual(api_lb.status_code, 200)
        self.assertIsInstance(api_lb.json, list)

    def test_multi_model_pool_and_random_selection(self):
        models = hj.get_evaluation_models()
        expected = [
            "gemma-4-26b-a4b-it",
            "gemma-4-31b-it",
            "gemini-3.8-flash",
            "gemini-3.6-flash",
            "gemini-3-flash-preview",
            "gemini-3.5-flash-lite",
        ]
        for exp in expected:
            self.assertIn(exp, models)

        # Random model selection returns one of the pool models
        selected = hj.get_random_evaluation_model()
        self.assertIn(selected, models)

        # Health endpoint reports multi-model metadata
        resp = self.client.get('/api/health')
        self.assertEqual(resp.status_code, 200)
        data = resp.json
        self.assertTrue(data.get("ai_configured"))
        self.assertEqual(data.get("models_count"), len(models))
        self.assertIn("gemma-4-26b-a4b-it", data.get("ai_models", []))
        self.assertIn("gemini-3.8-flash", data.get("ai_models", []))


if __name__ == '__main__':
    unittest.main()

