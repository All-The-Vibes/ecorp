"""PR265 actual browser/server/native-runner acceptance, never a component mock.

Use qa_factory_run_activity.ps1 -Phase DryRun, then Start on a NEW owned root.
Install Python Playwright separately (e.g. --target <qa>/python); use PYTHONPATH.
Run --dry-run, --phase prepare, then --phase accept. All artifacts stay in <qa>.
The supervisor's Status gate rechecks native process and listener ownership.
No reset, real GitHub/provider, publication, or product-source mutation is allowed.
Only fixed-crew binding and role/room negative fixtures use SQL in the owned DB.
Network failures are injected at browser transport, never by supplying fake data.
Failed reports/operations remain retained; do not rerun an uncertain mutation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
import uuid


PRODUCT = Path(__file__).resolve().parent.parent
SUITE = "pr265-run-activity"
GATE = {"type": "independent_review", "roles": ["owner", "admin", "manager", "member"], "exclude_requester": True}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def timestamp():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def validate_root(value):
    path = Path(value)
    assert path.is_absolute(), "An absolute dedicated QA root is required"
    assert ".." not in path.parts, "Do not normalize traversal into an owned path"
    assert re.fullmatch(r"pr265-run-activity-[A-Za-z0-9-]+", path.name)
    assert path.parent.name == "qa" and not path.is_relative_to(PRODUCT)
    assert not path.is_symlink(), "QA root cannot redirect"
    return path.resolve()


class Acceptance:
    def __init__(self, args):
        self.qa = validate_root(args.qa_root)
        self.pg = Path(args.postgres_bin).resolve()
        self.receipt = json.loads((self.qa / "ownership.json").read_text())
        r = self.receipt
        assert r["purpose"] == SUITE and r["test_owned"] is True and r["schema_version"] == 2
        assert Path(r["workspace"]).resolve() == self.qa
        assert Path(r["plan"]["product"]).resolve() == PRODUCT
        assert r["plan"]["runner_id"] == "pr265-activity-qa"
        self.server, self.web = r["plan"]["server"], r["plan"]["web"]
        for origin in (self.server, self.web):
            assert re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{4}", origin)
            assert int(origin.rsplit(":", 1)[1]) <= 65535
        db = r["plan"]["database"]
        assert db["host"] == "127.0.0.1" and db["name"] == "pr265_activity"
        assert 10000 <= db["port"] <= 65535
        assert len({int(self.server.rsplit(":", 1)[1]), int(self.web.rsplit(":", 1)[1]), db["port"]}) == 3
        self.demo, self.source = r["demo"], r["source"]
        self.out = self.qa / "evidence"
        self.cp_path = self.out / "acceptance.json"
        self.cp = json.loads(self.cp_path.read_text()) if self.cp_path.exists() else None
        self.errors = []

    def ownership(self):
        subprocess.run(["pwsh", "-NoProfile", "-File", str(PRODUCT / "tools/qa_factory_run_activity.ps1"),
                        "-Phase", "Status", "-QaRoot", str(self.qa), "-PostgresBin", str(self.pg)],
                       check=True, timeout=30, capture_output=True)

    def save(self):
        self.cp["updated_at"] = timestamp()
        tmp = self.cp_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.cp, indent=2) + "\n", encoding="utf-8")
        tmp.replace(self.cp_path)

    def api(self, suffix):
        return f'/api/corps/{self.demo["corp_id"]}{suffix}'

    def request(self, route, body=None):
        assert route.startswith("/api/") and not route.startswith("//")
        req = urllib.request.Request(self.server + route,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.loads(response.read(16 * 1024 * 1024))
        except urllib.error.HTTPError as err:
            # Claim/enrollment responses may contain capabilities; never dump bodies.
            detail = err.read(2000).decode(errors="replace") if route.endswith("/factory/preflight") else "body withheld"
            raise AssertionError(f"{req.get_method()} {route.split('?')[0]} returned HTTP {err.code}: {detail}") from None

    def post(self, name, route, body):
        previous = next((op for op in self.cp["operations"] if op["name"] == name), None)
        assert previous is None, f"Existing operation {name}: inspect checkpoint; no uncertain retry"
        operation = {"name": name, "route": route, "intent_at": timestamp(), "completed": False}
        self.cp["operations"].append(operation)
        self.save()
        result = self.request(route, body)
        operation["completed"] = True
        operation["ids"] = {key: result[key] for key in ("mission_id", "run_id", "task_id") if key in result}
        self.save()
        return result

    def snapshot(self, actor=None):
        return self.request(self.api(f'/snapshot?actor_id={actor or self.demo["alice_actor_id"]}'))

    def graph(self, snap=None):
        s = (snap or self.snapshot())["snapshot"]
        tasks = [t for t in s["tasks"] if t["mission_id"] == self.cp["mission_id"]]
        ids = {t["id"] for t in tasks}
        return {"mission": next(m for m in s["missions"] if m["id"] == self.cp["mission_id"]),
                "tasks": tasks, "runs": [r for r in s["runs"] if r["task_id"] in ids]}

    def wait(self, probe, label, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = probe()
            if result:
                return result
            if hasattr(self, "pump"):
                self.pump(200)  # Keep Playwright's transparent transport callbacks serviced.
            else:
                time.sleep(.2)
        raise AssertionError(f"Timed out: {label}; retain exact fixture IDs")

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.qa / "source"), *args], text=True).strip()

    def source_state(self):
        return {"head": self.git("rev-parse", "HEAD"), "status": self.git("status", "--porcelain"),
                "readme_sha256": sha((self.qa / "source/README.md").read_bytes())}

    def sql(self, statement):
        # Test-owner fixture setup only: native psql, an exact private loopback
        # database, no ambient libpq connection/credential settings or shell.
        db = self.receipt["plan"]["database"]
        env = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        env.update(PGHOST="127.0.0.1", PGPORT=str(db["port"]), PGDATABASE="pr265_activity", PGUSER="pr265_qa")
        result = subprocess.run([str(self.pg / "psql.exe"), "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
                                input=statement, text=True, capture_output=True, env=env, timeout=20)
        assert result.returncode == 0, "Owned fixture SQL failed; details withheld"
        return result.stdout.strip()

    def prepare(self):
        assert self.cp is None or (self.cp["status"] == "preparing" and all(
            op["name"] in ("seed-crew", "bind-second-test-worker") and op["completed"] for op in self.cp["operations"])), \
            "Existing stateful fixture checkpoint is retained; do not recreate work"
        s = self.snapshot()
        assert all(not s["snapshot"][table] for table in ("missions", "tasks", "runs", "factory_work_items"))
        assert len(s["runners"]) == 1 and s["runners"][0]["id"] == "pr265-activity-qa"
        cap = next(c for c in s["runners"][0]["capabilities"] if c["name"] == "workspace-isolation")
        assert cap["available"] and [cap["source_repository"], cap["source_base_ref"], cap["source_base_commit"]] == list(self.source[k] for k in ("repository", "base_ref", "base_commit"))
        self.cp = self.cp or {"suite": SUITE, "status": "preparing", "started_at": timestamp(),
                   "scope": "Real browser/server/PostgreSQL/native deterministic runner; no AI inference or production identity",
                   "source": self.source, "source_before": self.source_state(),
                   "product_commit": self.receipt["plan"]["product_commit"], "operations": [], "checks": {}}
        if not self.cp_path.exists():
            with self.cp_path.open("x", encoding="utf-8") as handle:
                json.dump(self.cp, handle)
        # The existing Factory fake-process planner intentionally uses the fixed
        # fixture crew; dynamic provider staffing is not the path under test.
        if not any(a["adapter"] == "fake-process" for a in s["snapshot"]["agents"]):
            self.post("seed-crew", "/api/demo/bootstrap?seed_crew=true", {})
        if not any(op["name"] == "bind-second-test-worker" for op in self.cp["operations"]):
            worker = next(a for a in self.snapshot()["snapshot"]["agents"] if a["name"] == "Claudia")
            assert worker["adapter"] == "claude-code" and not self.snapshot()["snapshot"]["runs"]
            operation = {"name": "bind-second-test-worker", "completed": False, "agent_id": worker["id"]}
            self.cp["operations"].append(operation)
            self.save()
            # Existing Factory fake-process planning uses fixed fixture crew.
            # Bind its second specialist to the real deterministic adapter before
            # any task exists. Do not fake runtime events, outputs or verification.
            assert self.sql(f"WITH changed AS (UPDATE agents SET adapter='fake-process' WHERE id='{uuid.UUID(worker['id'])}' AND adapter='claude-code' RETURNING id) SELECT count(*) FROM changed;") == "1"
            operation["completed"] = True
            self.save()
        nonce = str(uuid.uuid4())
        policy = {"schema_version": 1, "source_of_truth": "github_project", "project_status": "Todo",
                  "repository_allowlist": [self.source["repository"]], "source_base_ref": self.source["base_ref"],
                  "source_base_commit": self.source["base_commit"], "adapter_allowlist": ["fake-process"],
                  "strategy_allowlist": ["parallel-specialists"], "model": None, "reasoning_effort": None,
                  "write_scope": ["**"], "allowed_tools": ["filesystem", "shell"],
                  "prohibited_actions": ["modify files outside the assigned worktree", "publish, merge, or deploy"],
                  "secret_ids": [], "verification_required": True, "budget_tokens": 90000,
                  "budget_cost_microusd": 1000000, "auto_merge": False}
        material = {"actor_id": self.demo["alice_actor_id"],
                    "title": "[slow] [portable-deliverable] PR265 Factory activity acceptance",
                    "description": "Deterministic acceptance only. Exercise exact-run review and retained source. No real GitHub effects.",
                    "preferred_adapter": "fake-process", "strategy": "parallel-specialists",
                    "budget_tokens": 90000, "budget_cost_microusd": 1000000,
                    "deliverable": {"form": "archive", "commit_after_verification": False},
                    "contract": {"objective": "Exercise Factory run activity against authoritative state.",
                                 "expected_output": "Verified synthetic source and exact-run evidence.",
                                 "acceptance_tests": ["Retained source is unchanged", "Outcome reviews stay run scoped"],
                                 "allowed_tools": policy["allowed_tools"], "prohibited_actions": policy["prohibited_actions"],
                                 "references": [], "write_scope": ["**"]}}
        preflight = self.request(self.api("/factory/preflight"), {
            **material, "source_repository_owner": "ecorp-fixture", "source_repository_name": "pr265-run-activity", "policy": policy})
        assert preflight["valid"] and preflight["task_count"] == 3
        assert not self.snapshot()["snapshot"]["factory_work_items"], "Preflight must not claim"
        self.cp["checks"]["native_preflight_no_mutation"] = True
        claim = self.post("claim", self.api("/factory/work-items/claim"), {
            "actor_id": self.demo["alice_actor_id"], "source_project_owner": "ecorp-fixture", "source_project_number": 265,
            "source_project_item_id": "PVTI_PR265_" + nonce, "source_repository_owner": "ecorp-fixture",
            "source_repository_name": "pr265-run-activity", "source_issue_number": 265, "source_issue_node_id": "I_PR265_" + nonce,
            "source_issue_url": "https://github.com/ecorp-fixture/pr265-run-activity/issues/265",
            "source_title": "PR265 deterministic run-activity acceptance", "source_revision": timestamp(),
            "idempotency_key": "pr265-claim-" + nonce, "lease_seconds": 600, "policy": policy})
        self.cp["work_item_id"] = claim["work_item"]["id"]
        self.save()
        result = self.post("materialize", self.api(f'/factory/work-items/{self.cp["work_item_id"]}/materialize'), {
            **material, "claim_token": claim["claim_token"], "expected_version": claim["work_item"]["version"],
            "idempotency_key": "pr265-materialize-" + nonce})
        self.cp["mission_id"] = result["mission_id"]
        self.save()
        graph = self.graph()
        assert graph["mission"]["status"] == "ready" and not graph["runs"]
        roots = [t for t in graph["tasks"] if t["depth"] == 0]
        assert len(roots) == 2
        for task in roots:
            self.post("gate-" + task["id"], self.api(f'/missions/{self.cp["mission_id"]}/contract-revisions'), {
                "actor_id": self.demo["alice_actor_id"], "task_id": task["id"], "expected_contract_version": 1,
                "next_action": "redispatch", "source_run_id": None, "reason": "Independent root review for PR265 acceptance.",
                "idempotency_key": str(uuid.uuid4()), "description": material["description"], "contract": task["contract"],
                "verification_policy": {**task["verification_policy"], "manual_gate": GATE}})
        self.cp["root_task_ids"] = [t["id"] for t in roots]
        self.cp["status"] = "prepared"
        self.save()
        print(json.dumps({"status": "prepared", "mission_id": self.cp["mission_id"], "work_item_id": self.cp["work_item_id"]}))

    def inspect(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 1050})
                page.goto(self.web + "/#factory", wait_until="networkidle")
                page.locator(".live-live").wait_for()
                print(page.locator("body").inner_text())
                page.screenshot(path=str(self.out / ("inspection-" + str(uuid.uuid4()) + ".png")), full_page=True)
            finally:
                browser.close()

    def diagnose(self):
        """Read-only readback of the preserved review-loss reproduction."""
        snapshot = self.snapshot()["snapshot"]
        run_ids = {self.cp["older_run_id"], self.cp["newer_run_id"]}
        runs = [r for r in snapshot["runs"] if r["id"] in run_ids]
        reviews = [r for r in snapshot["verification_requests"] if r["run_id"] in run_ids]
        losses = [e for e in snapshot["events"] if e["aggregate_id"] in run_ids and e["type"] == "run.lost"]
        assert len(runs) == len(reviews) == len(losses) == 2
        assert all(r["status"] == "lost" and r["workspace_disposition"] == "preserved" for r in runs)
        assert all(r["status"] == "pending" for r in reviews)
        assert all(e["payload"].get("reason") == "runner reconnected without an active claim" for e in losses)
        self.cp["status"] = "blocked"
        self.cp["checks"]["native_runner_reconnect"] = {
            "passed": False, "transport_reconnected": True, "review_state_preserved": False,
            "run_ids": sorted(run_ids), "reason": "runner reconnected without an active claim"}
        self.cp["blockers"] = [{"name": "native_runner_reconnect_loses_finished_reviews",
            "requires": "Backend lifecycle scope approval; no backend edits made",
            "runs": [{k: r[k] for k in ("id", "task_id", "status", "verification_status", "workspace_disposition", "artifact_id")} for r in runs],
            "reviews": [{k: r[k] for k in ("run_id", "task_id", "status", "decided_by")} for r in reviews],
            "loss_events": [{k: e[k] for k in ("id", "seq", "created_at")} for e in losses]}]
        self.cp["retained_after_failure"] = self.retain()
        self.save()
        print(json.dumps(self.cp["blockers"], indent=2))

    def check(self, name, value=True):
        self.cp["checks"][name] = value
        self.save()
        print("PASS " + name, flush=True)

    def notify(self, name):
        return self.post(name, self.api(f'/rooms/{self.demo["room_id"]}/messages'), {
            "actor_id": self.demo["alice_actor_id"], "body": "PR265 test event: " + name,
            "reply_to_id": None, "mentions": [], "link": {"kind": "mission", "id": self.cp["mission_id"]},
            "idempotency_key": str(uuid.uuid4())})

    def capture(self, page, name):
        filename = name + "-" + str(uuid.uuid4())[:8] + ".png"
        page.screenshot(path=str(self.out / filename), full_page=True)
        self.cp.setdefault("screenshots", {})[name] = filename
        self.save()
        return filename

    def retain(self):
        graph = self.graph()
        s = self.snapshot()["snapshot"]
        proof = []
        for run in graph["runs"]:
            assert run["runner_id"] == "pr265-activity-qa" and run["workspace_disposition"] == "preserved"
            worktree = Path(run["workspace_path"]).resolve()
            assert worktree.is_relative_to(self.qa / "runner") and not worktree.is_relative_to(self.qa / "source")
            assert (worktree / ".git").is_file() and run["workspace_base_commit"] == self.source["base_commit"]
            events = [e for e in s["events"] if e["aggregate_id"] == run["id"]]
            types = {e["type"] for e in events}
            assert {"run.started", "run.session_terminated", "run.workspace_preserved"} <= types
            assert any(e["type"] == "run.session_terminated" and e["payload"].get("provider_process_alive") is False for e in events)
            artifact = (worktree / "result.md").read_bytes()
            assert sha(artifact) == run["artifact_sha256"]
            with urllib.request.urlopen(self.server + run["artifact_uri"] + "?actor_id=" + self.demo["bob_actor_id"], timeout=20) as response:
                assert response.status == 200 and response.read() == artifact
            proof.append({"run_id": run["id"], "task_id": run["task_id"], "status": run["status"],
                          "artifact_id": run["artifact_id"], "artifact_sha256": sha(artifact),
                          "workspace": str(worktree.relative_to(self.qa)), "fingerprint": run.get("workspace_fingerprint"),
                          "events": [{"id": e["id"], "seq": e["seq"], "type": e["type"]} for e in events
                                     if e["type"] in ("run.started", "run.session_terminated", "run.workspace_preserved", "run.completed", "run.verification_waiting")]})
        assert self.source_state() == self.cp["source_before"]
        assert not s["pull_request_publications"]
        return proof

    def accept(self):
        from playwright.sync_api import sync_playwright, expect
        assert self.cp is not None and self.cp["status"] in ("prepared", "accepting", "accepted")
        self.cp["status"] = "accepting"
        self.save()
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion="reduce")
            context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(
                (self.web + "/", self.server + "/", "data:", "blob:")) else route.abort())
            # Observe native socket handles only. No frames, API responses or
            # application state are replaced. This avoids stale routed-socket
            # close handles across StrictMode and viewer changes.
            context.add_init_script("""(() => {
                const NativeWebSocket = window.WebSocket;
                const transport = {blocked: false, sockets: new Set()};
                window.__pr265Transport = transport;
                window.WebSocket = class extends NativeWebSocket {
                    constructor(...args) {
                        super(...args);
                        // Do not disconnect Vite's separate HMR transport:
                        // its reconnect would reload the document under test.
                        if (!this.url.startsWith(__APP_WS_PREFIX__)) return;
                        transport.sockets.add(this);
                        this.addEventListener('close', () => transport.sockets.delete(this));
                        if (transport.blocked) this.close();
                    }
                };
            })();""".replace("__APP_WS_PREFIX__", json.dumps(self.server.replace("http", "ws", 1) + "/ws/corps/")))
            def disconnect():
                count = page.evaluate("""() => {
                    const t = window.__pr265Transport;
                    t.blocked = true;
                    const live = [...t.sockets].filter(s => s.readyState < WebSocket.CLOSING);
                    for (const socket of live) socket.close(1000, 'PR265 deliberate disconnect');
                    return live.length;
                }""")
                assert count > 0, "No current native browser transport to disconnect"
            def reconnect():
                page.evaluate("window.__pr265Transport.blocked = false")
            page = context.new_page()
            self.pump = page.wait_for_timeout
            page.on("pageerror", lambda error: self.errors.append(str(error)))
            mid = self.cp["mission_id"]

            def factory():
                page.get_by_role("link", name="Factory", exact=True).click()
                panel = page.get_by_test_id("factory-panel")
                expect(panel).to_be_visible()
                return panel

            def details():
                return page.get_by_test_id("factory-panel").get_by_test_id("run-activity-details")

            def actor(actor_id):
                page.locator("#operator-actor").select_option(actor_id)
                expect(page.locator("#operator-actor")).to_have_value(actor_id)
                expect(page.locator(".live-live")).to_be_visible(timeout=20000)

            def open_run(run_id):
                panel = factory()
                expect(details()).to_have_attribute("data-run-id", run_id)
                panel.get_by_test_id("work-result-card").get_by_role("button", name="Review this run", exact=True).click()
                evidence = page.locator(f'#mission-evidence-panel-{mid}')
                expect(evidence).to_have_attribute("data-evidence-run-id", run_id)
                expect(page.locator(f'#mission-evidence-{mid}')).to_have_value(run_id)
                return page.locator(f'[data-mission-id="{mid}"]')

            try:
                page.goto(self.web + "/#factory", wait_until="networkidle")
                expect(page.locator(".live-live")).to_be_visible(timeout=20000)
                if "browser_dispatch" not in self.cp["checks"]:
                    assert not self.graph()["runs"], "Do not relaunch an uncertain existing mission"
                    factory().get_by_test_id("work-result-card").get_by_role("button", name="Open mission and results", exact=True).click()
                    card = page.locator(f'[data-mission-id="{mid}"]')
                    operation = {"name": "browser-launch", "completed": False, "intent_at": timestamp()}
                    assert not any(op["name"] == "browser-launch" for op in self.cp["operations"])
                    self.cp["operations"].append(operation)
                    self.save()
                    with page.expect_response(lambda response: response.url == self.server + self.api(f"/missions/{mid}/launch") and response.request.method == "POST") as result:
                        card.get_by_test_id("work-result-card").get_by_role("button", name="Start mission", exact=True).click()
                    response = result.value
                    assert response.status == 200
                    operation["completed"] = True
                    operation["response"] = response.json()
                    self.save()
                    graph = self.wait(lambda: self.graph() if len(self.graph()["runs"]) == 2 else None, "two native roots")
                    roots = sorted(graph["runs"], key=lambda run: (run["created_at"], run["id"]))
                    self.cp["older_run_id"], self.cp["newer_run_id"] = [run["id"] for run in roots]
                    assert all(run["task_id"] in self.cp["root_task_ids"] for run in roots)
                    factory()
                    expect(details()).to_have_attribute("data-run-id", roots[-1]["id"])
                    expect(details()).to_contain_text("Provider run reported active", timeout=15000)
                    self.capture(page, "running-desktop")
                    self.check("browser_dispatch", {"root_runs": [r["id"] for r in roots], "launch": operation["response"]})

                if "browser_disconnect_review_replay" not in self.cp["checks"]:
                    factory()
                    before = self.graph()
                    assert len(before["runs"]) == 2
                    disconnect()
                    expect(page.locator(".live-live")).not_to_be_visible(timeout=15000)
                    expect(details()).to_contain_text("Live updates are unavailable", timeout=15000)
                    self.capture(page, "disconnected")
                    def roots_waiting():
                        graph = self.graph()
                        return graph if len(graph["runs"]) == 2 and all(r["status"] == "waiting_for_approval" and
                            r["workspace_disposition"] == "preserved" for r in graph["runs"]) else None
                    after = self.wait(roots_waiting, "native roots to finish while browser is offline")
                    assert {r["id"] for r in after["runs"]} == {r["id"] for r in before["runs"]}
                    assert all(r["artifact_id"] for r in after["runs"])
                    reconnect()
                    expect(page.locator(".live-live")).to_be_visible(timeout=20000)
                    expect(factory().get_by_test_id("work-result-card")).to_contain_text("This outcome needs review", timeout=20000)
                    expect(details()).not_to_contain_text("Live updates are unavailable")
                    self.capture(page, "reconnected-review")
                    self.check("browser_disconnect_review_replay", {"same_run_ids": True,
                        "native_artifacts_created_while_offline": not all(r["artifact_id"] for r in before["runs"]),
                        "native_websocket_no_frame_interception": True})

                older, newer = self.cp["older_run_id"], self.cp["newer_run_id"]
                if "snapshot_read_failure" not in self.cp["checks"]:
                    factory()
                    previous = details().locator("dl.work-result-facts > div").last.inner_text()
                    pattern = self.server + "/api/corps/*/snapshot?*"
                    context.route(pattern, lambda route: route.fulfill(status=503, content_type="application/json", body='{"error":"PR265 deliberate snapshot transport failure"}'))
                    self.notify("snapshot-failure-" + str(uuid.uuid4()))
                    expect(details()).to_contain_text("The last snapshot refresh failed", timeout=20000)
                    expect(factory().get_by_test_id("work-result-card")).to_contain_text("Updates unavailable")
                    expect(details()).to_have_attribute("data-run-id", newer)
                    self.capture(page, "snapshot-read-failure")
                    # The failure is scoped to Alice's retained snapshot. Switching
                    # to Bob must issue a real, independent, successful read.
                    context.unroute(pattern)
                    actor(self.demo["bob_actor_id"])
                    expect(details()).not_to_contain_text("The last snapshot refresh failed", timeout=20000)
                    self.check("snapshot_read_failure", {"retained_snapshot_before": previous, "run_retained": newer,
                        "failed_status": 503, "bob_fresh_scope": True})

                actor(self.demo["bob_actor_id"])
                if "native_runner_reconnect" not in self.cp["checks"]:
                    before_states = {r["id"]: r["status"] for r in self.graph()["runs"]}
                    self.post("runner-disconnect", "/api/demo/runners/pr265-activity-qa/disconnect", {"reconnect_delay_ms": 2000})
                    self.wait(lambda: self.snapshot()["runners"][0]["status"] == "grace", "native runner enters grace")
                    expect(details()).to_contain_text("Runner: Grace", timeout=15000)
                    self.capture(page, "runner-grace")
                    self.wait(lambda: self.snapshot()["runners"][0]["status"] == "connected", "native runner reconnects")
                    expect(details()).to_contain_text("Runner: Connected", timeout=15000)
                    page.wait_for_timeout(3000)  # Registration is not completion of native reconciliation.
                    after_states = {r["id"]: r["status"] for r in self.graph()["runs"]}
                    if after_states != before_states:
                        self.diagnose()
                        raise AssertionError("Native runner reconnect changed the finished review state; acceptance is blocked")
                    self.check("native_runner_reconnect", {"grace_observed_api_and_ui": True, "same_run_ids": True,
                        "connected_again": True})
                if "role_and_room_changes" not in self.cp["checks"]:
                    bob = str(uuid.UUID(self.demo["bob_actor_id"]))
                    room = str(uuid.UUID(self.demo["room_id"]))
                    original = json.loads(self.sql(f"SELECT row_to_json(r) FROM room_memberships r WHERE actor_id='{bob}' AND room_id='{room}';"))
                    assert original["role"] == "member"
                    try:
                        assert self.sql(f"WITH c AS (UPDATE actors SET role='spectator' WHERE id='{bob}' AND role='member' RETURNING id) SELECT count(*) FROM c;") == "1"
                        self.notify("role-demoted-" + str(uuid.uuid4()))
                        expect(page.locator("#operator-actor option:checked")).to_contain_text("spectator", timeout=20000)
                        expect(factory().get_by_test_id("run-activity-details")).to_have_count(0)
                        assert not self.snapshot(bob)["snapshot"]["factory_work_items"]
                        self.capture(page, "role-hidden")
                    finally:
                        self.sql(f"UPDATE actors SET role='member' WHERE id='{bob}' AND role='spectator';")
                        self.notify("role-restored-" + str(uuid.uuid4()))
                    expect(page.locator("#operator-actor option:checked")).to_contain_text("member", timeout=20000)
                    expect(details()).to_have_attribute("data-run-id", newer)
                    try:
                        assert self.sql(f"WITH c AS (DELETE FROM room_memberships WHERE actor_id='{bob}' AND room_id='{room}' RETURNING actor_id) SELECT count(*) FROM c;") == "1"
                        actor(self.demo["alice_actor_id"])
                        actor(bob)
                        expect(factory().get_by_test_id("run-activity-details")).to_have_count(0)
                        snap = self.snapshot(bob)["snapshot"]
                        assert not any(m["id"] == mid for m in snap["missions"])
                        assert not any(r["id"] in (older, newer) for r in snap["runs"])
                        # Baseline snapshot() selects Factory intake by Corp/operator
                        # role, without a room join. PR265 does not change that query.
                        # Assert the new activity clears; report the wider metadata
                        # limitation explicitly instead of claiming it was hidden.
                        self.cp.setdefault("known_limits", {})["baseline_factory_intake_visibility"] = {
                            "item_metadata_returned_after_room_removal": any(i["id"] == self.cp["work_item_id"] for i in snap["factory_work_items"]),
                            "mission_and_run_hidden": True, "new_activity_hidden": True,
                            "source": "Unchanged crony-store snapshot Factory query is Corp/operator scoped, not room joined."}
                        self.save()
                        self.capture(page, "room-hidden")
                    finally:
                        joined = original["joined_at"].replace("'", "''")
                        self.sql(f"INSERT INTO room_memberships(room_id,actor_id,role,joined_at) VALUES ('{room}','{bob}','member','{joined}') ON CONFLICT DO NOTHING;")
                    actor(self.demo["alice_actor_id"])
                    actor(bob)
                    expect(details()).to_have_attribute("data-run-id", newer)
                    actor(self.demo["eve_actor_id"])
                    expect(factory().get_by_test_id("run-activity-details")).to_have_count(0)
                    actor(bob)
                    expect(details()).to_have_attribute("data-run-id", newer)
                    self.check("role_and_room_changes", {"demotion_hides_factory": True, "room_removal_hides_mission_and_activity": True,
                        "restored_scope_fresh": True, "guest_switch_no_leak": True, "fixture_membership_restored": True})

                if "newer_review_accepted" not in self.cp["checks"]:
                    already_completed = next(r for r in self.graph()["runs"] if r["id"] == newer)["status"] == "completed"
                    if already_completed:
                        review = next(r for r in self.snapshot()["snapshot"]["verification_requests"] if r["run_id"] == newer)
                        assert review["status"] == "approved" and review["decided_by"] == self.demo["bob_actor_id"]
                    else:
                        card = open_run(newer)
                        with page.expect_response(lambda response: "/verification-decision" in response.url and response.request.method == "POST") as result:
                            card.get_by_role("button", name="Accept evidence", exact=True).click()
                        assert result.value.status == 200
                    self.wait(lambda: next(r for r in self.graph()["runs"] if r["id"] == newer)["status"] == "completed", "newer outcome accepted")
                    self.check("newer_review_accepted", {"run_id": newer, "actor_id": self.demo["bob_actor_id"],
                        "recovered_existing_decision_without_resubmission": already_completed})

                if "older_review_exact_navigation" not in self.cp["checks"]:
                    factory().get_by_role("button", name="Open mission and results", exact=True).click()
                    page.locator(f'#mission-evidence-{mid}').select_option(newer)
                    expect(page.locator(f'#mission-evidence-panel-{mid}')).to_have_attribute("data-evidence-run-id", newer)
                    factory()
                    expect(details()).to_have_attribute("data-run-id", older, timeout=20000)
                    expect(factory().get_by_test_id("work-result-card")).to_contain_text("This outcome needs review")
                    self.capture(page, "older-review-over-newer-completed")
                    card = open_run(older)
                    expect(card.get_by_test_id("provider-evidence")).to_have_attribute("data-artifact-id",
                        next(r for r in self.graph()["runs"] if r["id"] == older)["artifact_id"])
                    with page.expect_download() as download:
                        card.get_by_test_id("provider-evidence").get_by_role("button").click()
                    download_bytes = Path(download.value.path()).read_bytes()
                    run = next(r for r in self.graph()["runs"] if r["id"] == older)
                    assert sha(download_bytes) == run["artifact_sha256"]
                    self.capture(page, "exact-older-run-evidence")
                    self.check("older_review_exact_navigation", {"remembered_newer_run": newer, "navigated_older_run": older,
                        "actual_browser_download_sha256": sha(download_bytes), "artifact_id": run["artifact_id"]})

                if "keyboard_and_390px" not in self.cp["checks"]:
                    factory()
                    summary = details().locator("summary")
                    expect(details().locator("details")).not_to_have_attribute("open", "")
                    # Reach the actual native summary with Tab, not a synthetic click.
                    page.get_by_role("link", name="Factory", exact=True).focus()
                    for _ in range(80):
                        page.keyboard.press("Tab")
                        if summary.evaluate("element => element === document.activeElement"):
                            break
                    else:
                        raise AssertionError("Activity disclosure was not keyboard reachable")
                    assert summary.evaluate("element => element.matches(':focus-visible')")
                    page.keyboard.press("Enter")
                    expect(details().locator("details")).to_have_attribute("open", "")
                    assert 1 <= details().locator("ol li").count() <= 5
                    expect(details()).to_contain_text("not its complete history")
                    expect(details()).not_to_contain_text("Mission accepted:")
                    self.capture(page, "keyboard-expanded")
                    page.set_viewport_size({"width": 390, "height": 844})
                    size = page.evaluate("({width: innerWidth, height: innerHeight, content: document.documentElement.scrollWidth})")
                    assert size["width"] == 390 and size["height"] == 844 and size["content"] <= 390, size
                    expect(details()).to_be_visible()
                    self.capture(page, "mobile-390-expanded")
                    page.keyboard.press("Enter")
                    self.capture(page, "mobile-390-collapsed")
                    self.check("keyboard_and_390px", {**size, "tab_reachable": True, "enter_expands": True, "focus_visible": True,
                        "bounded_timeline": details().locator("ol li").count()})
                    page.set_viewport_size({"width": 1440, "height": 1050})

                if "source_preserved_before_final_decision" not in self.cp["checks"]:
                    self.check("source_preserved_before_final_decision", self.retain())

                if "final_completed" not in self.cp["checks"]:
                    card = open_run(older)
                    with page.expect_response(lambda response: "/verification-decision" in response.url and response.request.method == "POST") as result:
                        card.get_by_role("button", name="Accept evidence", exact=True).click()
                    assert result.value.status == 200
                    graph = self.wait(lambda: self.graph() if len(self.graph()["runs"]) == 3 else None, "native synthesis starts")
                    synthesis = next(r for r in graph["runs"] if r["id"] not in (older, newer))
                    assert synthesis["status"] in ("provisioning", "starting", "running") and not synthesis["artifact_id"]
                    factory()
                    expect(details()).to_have_attribute("data-run-id", synthesis["id"], timeout=15000)
                    expect(details()).to_contain_text("Provider run reported active", timeout=15000)
                    disconnect()
                    expect(page.locator(".live-live")).not_to_be_visible(timeout=10000)
                    expect(details()).to_contain_text("Live updates are unavailable", timeout=10000)
                    self.capture(page, "native-synthesis-disconnected")
                    def finished():
                        graph = self.graph()
                        return graph if graph["mission"]["status"] == "completed" and len(graph["runs"]) == 3 and all(
                            r["status"] == "completed" and r["workspace_disposition"] == "preserved" for r in graph["runs"]) else None
                    graph = self.wait(finished, "dependent synthesis and final verification")
                    assert all(t["attempt_count"] == 1 and t["verification_status"] == "passed" for t in graph["tasks"])
                    finished_synthesis = next(r for r in graph["runs"] if r["id"] == synthesis["id"])
                    assert finished_synthesis["artifact_id"] and finished_synthesis["runner_id"] == synthesis["runner_id"]
                    self.check("browser_disconnect_runner_survival", {"run_id": synthesis["id"], "same_runner": True,
                        "artifact_created_while_disconnected": True, "no_replacement_run": len(graph["runs"]) == 3})
                    reconnect()
                    expect(page.locator(".live-live")).to_be_visible(timeout=20000)
                    factory()
                    expect(factory().get_by_test_id("work-result-card")).to_contain_text("The mission is complete", timeout=20000)
                    self.capture(page, "completed")
                    factory().get_by_test_id("work-result-card").get_by_role("button", name="Open run and results", exact=True).click()
                    completed_card = page.locator(f'[data-mission-id="{mid}"]')
                    expect(page.locator(f'#mission-evidence-panel-{mid}')).to_have_attribute("data-evidence-run-id", synthesis["id"])
                    deliverable = next(d for d in self.snapshot()["snapshot"]["source_deliverables"] if d["run_id"] == synthesis["id"])
                    with page.expect_download() as download:
                        completed_card.get_by_test_id("source-deliverable").get_by_role("button", name="Download source deliverable").click()
                    downloaded = Path(download.value.path()).read_bytes()
                    assert sha(downloaded) == deliverable["sha256"] and len(downloaded) == deliverable["bytes"]
                    self.check("browser_source_download", {"run_id": synthesis["id"], "sha256": sha(downloaded), "bytes": len(downloaded)})
                    self.check("final_completed", {"mission_id": mid, "run_ids": [r["id"] for r in graph["runs"]], "exactly_once_attempts": True})
                self.check("source_preserved_final", self.retain())
                assert self.cp["checks"]["native_runner_reconnect"].get("passed", True), "Runner reconnect acceptance is required"
                assert not self.errors, self.errors
                self.cp["page_errors"] = self.errors
                self.cp["status"] = "accepted"
                self.cp["completed_at"] = timestamp()
                self.save()
                print(json.dumps({"status": "accepted", "report": str(self.cp_path)}), flush=True)
            except Exception:
                self.capture(page, "failure")
                print(page.locator("body").inner_text()[:18000], flush=True)
                raise
            finally:
                browser.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--qa-root", required=True)
    parser.add_argument("--postgres-bin", required=True)
    parser.add_argument("--phase", choices=["prepare", "inspect", "accept", "diagnose"], default="inspect")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    suite = Acceptance(args)
    if args.dry_run:
        print(json.dumps({"dry_run": True, "qa_root": str(suite.qa), "server": suite.server, "web": suite.web,
                          "phase": args.phase, "writes": False, "http_requests": 0,
                          "coverage": ["browser dispatch", "native process and artifact", "reconnect", "snapshot read failure",
                                       "role/room authority", "older review vs newer run", "exact-run navigation",
                                       "source retention", "390px viewport"]}, indent=2))
        return
    suite.ownership()
    try:
        getattr(suite, args.phase)()
    except Exception as error:
        if suite.cp is not None:
            suite.cp.setdefault("failures", []).append({"phase": args.phase, "at": timestamp(), "error": str(error)[:1000]})
            suite.save()
        raise


if __name__ == "__main__":
    main()
