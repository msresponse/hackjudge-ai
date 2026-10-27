"""
Automated Batch Evaluator for HackJudge-AI
Reads a list of student submissions (CSV/JSON), submits them to HackJudge-AI,
and exports comprehensive evaluation rankings and scores to CSV/JSON.
"""

import argparse
import json
import os
import sys
import time
from typing import Any, Dict, List
import pandas as pd
import requests

# Force live output so progress is visible immediately
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)

DEFAULT_BASE_URL = "http://127.0.0.1:5000"


def check_server(base_url: str):
    try:
        r = requests.get(f"{base_url}/api/health", timeout=5)
        r.raise_for_status()
        data = r.json()
        print(f"[+] Connected to HackJudge-AI server at {base_url}")
        print(f"    AI Configured: {data.get('ai_configured')} (Model: {data.get('ai_model')})")
        return data
    except Exception as e:
        print(f"[-] Could not connect to HackJudge-AI at {base_url}: {e}")
        sys.exit(1)


def ensure_hackathon(base_url: str, name: str, track: str = "Open Innovation", description: str = "") -> int:
    # Check if hackathon already exists
    r = requests.get(f"{base_url}/api/hackathons", timeout=10)
    if r.status_code == 200:
        for h in r.json():
            if h.get("name", "").strip().lower() == name.strip().lower():
                print(f"[+] Found existing hackathon '{name}' (ID: {h['id']})")
                return h["id"]

    # Create new hackathon with standard evaluation rubric
    payload = {
        "name": name,
        "track": track,
        "description": description or "Automated Batch Evaluation Hackathon",
        "criteria": [
            {"name": "Technical Execution & Architecture", "description": "Code structure, code quality, dependencies, and engineering practices", "weight": 35},
            {"name": "Originality & Innovation", "description": "Novel approach, creativity, and unique problem-solving value", "weight": 25},
            {"name": "Completeness & Functionality", "description": "Working features, documentation, tests, and usability", "weight": 25},
            {"name": "Impact & Practicality", "description": "Real-world applicability, problem significance, and polish", "weight": 15}
        ],
        "requirements": [
            "Must provide a valid public GitHub repository with a README."
        ]
    }
    r = requests.post(f"{base_url}/api/hackathons", json=payload, timeout=10)
    if r.status_code in (200, 201):
        data = r.json()
        print(f"[+] Created hackathon '{name}' (ID: {data['id']})")
        return data["id"]
    else:
        print(f"[-] Failed to create hackathon: {r.status_code} {r.text}")
        sys.exit(1)


def load_submissions(file_path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Submissions file not found: {file_path}")

    ext = os.path.splitext(file_path)[1].lower()
    if ext == ".csv":
        df = pd.read_csv(file_path)
        records = df.fillna("").to_dict(orient="records")
    elif ext in (".json", ".jsonl"):
        with open(file_path, "r", encoding="utf-8") as f:
            if ext == ".jsonl":
                records = [json.loads(line) for line in f if line.strip()]
            else:
                records = json.load(f)
    else:
        raise ValueError("Unsupported format. Use .csv or .json")
    return records


def evaluate_submission(base_url: str, hackathon_id: int, sub: Dict[str, Any]) -> Dict[str, Any]:
    # Normalize keys: lowercase, remove spaces/underscores
    norm = {str(k).lower().replace(" ", "").replace("_", ""): v for k, v in sub.items() if k is not None}

    github_url = str(norm.get("githuburl") or norm.get("githubrepositorylink") or norm.get("repourl") or norm.get("github") or norm.get("url") or norm.get("repo") or "").strip()
    
    # Auto-extract team and project names from the GitHub URL if missing
    owner, repo = "Unknown Team", "Unnamed Project"
    if github_url:
        try:
            parts = [p for p in github_url.rstrip("/").split("/") if p]
            if len(parts) >= 2:
                owner, repo = parts[-2], parts[-1].replace(".git", "")
        except Exception:
            pass

    team_name = str(norm.get("teamname") or norm.get("team") or owner).strip()
    project_name = str(norm.get("projectname") or norm.get("project") or norm.get("name") or repo).strip()
    demo_url = str(norm.get("demourl") or norm.get("demo") or norm.get("livelink") or "").strip()
    notes = str(norm.get("notes") or norm.get("description") or "").strip()

    print(f"\n[>>>] Evaluating Team: '{team_name}' | Project: '{project_name}'")
    print(f"      Repository: {github_url}")

    payload = {
        "hackathon_id": hackathon_id,
        "team_name": team_name,
        "project_name": project_name,
        "github_url": github_url,
        "demo_url": demo_url,
        "notes": notes
    }

    # Attempt evaluation with automatic retry for 50+ project batches
    max_retries = 2
    for attempt in range(1, max_retries + 1):
        try:
            r = requests.post(f"{base_url}/api/submissions", json=payload, timeout=240)
            data = r.json()
            status = data.get("status")
            score = data.get("score")
            method = data.get("assessment_method", "unknown")

            if status == "EVALUATED":
                print(f"      Status: {status} | Score: {score} | Method: {method}")
                return {
                    "submission_id": data.get("id"),
                    "team_name": team_name,
                    "project_name": project_name,
                    "github_url": github_url,
                    "status": status,
                    "score": score,
                    "method": method,
                    "summary": data.get("evaluation", {}).get("summary", ""),
                    "strengths": "; ".join(data.get("evaluation", {}).get("strengths", [])),
                    "risks": "; ".join(data.get("evaluation", {}).get("risks", [])),
                    "raw_response": data
                }
            elif attempt < max_retries:
                print(f"      Status: {status}. Retrying attempt {attempt+1}/{max_retries}...")
                time.sleep(3)
                continue
            else:
                print(f"      Status: {status} | Score: {score} | Method: {method}")
                return {
                    "submission_id": data.get("id"),
                    "team_name": team_name,
                    "project_name": project_name,
                    "github_url": github_url,
                    "status": status,
                    "score": score,
                    "method": method,
                    "summary": data.get("evaluation", {}).get("summary", ""),
                    "strengths": "; ".join(data.get("evaluation", {}).get("strengths", [])),
                    "risks": "; ".join(data.get("evaluation", {}).get("risks", [])),
                    "raw_response": data
                }
        except Exception as e:
            if attempt < max_retries:
                print(f"[-] Evaluation attempt {attempt} failed for {team_name} ({e}). Retrying in 4s...")
                time.sleep(4)
            else:
                print(f"[-] Evaluation failed for {team_name}: {e}")
                return {
                    "submission_id": None,
                    "team_name": team_name,
                    "project_name": project_name,
                    "github_url": github_url,
                    "status": "ERROR",
                    "score": 0.0,
                    "method": "failed",
                    "summary": str(e),
                    "strengths": "",
                    "risks": "",
                    "raw_response": {}
                }


def save_incremental(results: list, output_dir: str):
    """Save current results to CSV/JSON after every submission so no data is lost."""
    os.makedirs(output_dir, exist_ok=True)
    csv_path = os.path.join(output_dir, "results.csv")
    json_path = os.path.join(output_dir, "results.json")
    df = pd.DataFrame(results)
    if "score" in df.columns:
        df["score"] = pd.to_numeric(df["score"], errors="coerce").fillna(0.0)
        df = df.sort_values(by="score", ascending=False).reset_index(drop=True)
        df["rank"] = df.index + 1
    display_cols = ["rank", "team_name", "project_name", "score", "status", "method", "summary", "strengths", "risks", "github_url"]
    cols_to_use = [c for c in display_cols if c in df.columns]
    df[cols_to_use].to_csv(csv_path, index=False, encoding="utf-8")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    return df, csv_path, json_path


def run_batch(input_file: str, output_dir: str, hackathon_name: str, base_url: str = DEFAULT_BASE_URL, delay_sec: float = 2.0):
    check_server(base_url)
    hackathon_id = ensure_hackathon(base_url, hackathon_name)
    submissions = load_submissions(input_file)
    total = len(submissions)
    print(f"[+] Loaded {total} submission(s) from {input_file}", flush=True)
    print(f"[+] Results will be saved incrementally to: {os.path.abspath(output_dir)}/", flush=True)

    results = []
    for i, sub in enumerate(submissions, 1):
        print(f"\nProcessing [{i}/{total}]", flush=True)
        res = evaluate_submission(base_url, hackathon_id, sub)
        results.append(res)
        # Save after every single submission — no data lost on interrupt
        save_incremental(results, output_dir)
        print(f"  [saved] {i}/{total} results written to {output_dir}/results.csv", flush=True)
        if i < total:
            time.sleep(delay_sec)

    # Final sorted leaderboard
    df_results, csv_path, json_path = save_incremental(results, output_dir)

    print("\n" + "=" * 60, flush=True)
    print("EVALUATION BATCH COMPLETE - LEADERBOARD SUMMARY", flush=True)
    print("=" * 60, flush=True)
    summary_cols = ["rank", "team_name", "project_name", "score", "status", "method"]
    print(df_results[[c for c in summary_cols if c in df_results.columns]].to_string(index=False), flush=True)
    print("=" * 60, flush=True)
    print(f"[+] Full results exported to:", flush=True)
    print(f"    - CSV:  {os.path.abspath(csv_path)}", flush=True)
    print(f"    - JSON: {os.path.abspath(json_path)}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="HackJudge-AI Automated Batch Evaluator")
    parser.add_argument("--input", "-i", default="submissions.csv", help="Path to input submissions CSV or JSON file")
    parser.add_argument("--output", "-o", default="evaluation_results", help="Prefix for exported results (generates .csv and .json)")
    parser.add_argument("--hackathon", "-H", default="AI Hackathon 2026", help="Name of the hackathon event")
    parser.add_argument("--url", "-u", default=DEFAULT_BASE_URL, help="Base URL of HackJudge-AI server")
    parser.add_argument("--delay", "-d", type=float, default=2.0, help="Delay in seconds between evaluations to respect rate limits")

    args = parser.parse_args()
    run_batch(
        input_file=args.input,
        output_dir=args.output,
        hackathon_name=args.hackathon,
        base_url=args.url,
        delay_sec=args.delay
    )


if __name__ == "__main__":
    main()
