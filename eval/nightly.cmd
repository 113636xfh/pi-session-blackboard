@echo off
setlocal
cd /d "%~dp0.."
set SBB_EVAL_MODEL=strata/qwen3.8-flash-next-iq3_s
set SBB_EVAL_ROUNDS=2
set SBB_EVAL_TASK_MINUTES=7
set SBB_EVAL_MAX_TOOLS=6
node eval/nightly.mjs >> eval/results/nightly-run.log 2>&1
endlocal
