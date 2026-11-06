#!/usr/bin/env bash
set -euo pipefail

BASE_MODEL="${MEGA_BASE_MODEL:-Qwen/Qwen3.5-4B}"
HOST="${MEGA_HOST:-0.0.0.0}"
PORT="${MEGA_PORT:-8000}"
MAX_MODEL_LEN="${MEGA_MAX_MODEL_LEN:-8192}"
GPU_MEMORY_UTILIZATION="${MEGA_GPU_MEMORY_UTILIZATION:-0.88}"

ARGS=(
  serve "$BASE_MODEL"
  --host "$HOST"
  --port "$PORT"
  --served-model-name mega-base
  --max-model-len "$MAX_MODEL_LEN"
  --gpu-memory-utilization "$GPU_MEMORY_UTILIZATION"
  --tensor-parallel-size "${MEGA_TENSOR_PARALLEL_SIZE:-1}"
  --language-model-only
)

if [[ -n "${MEGA_INFERENCE_API_KEY:-}" ]]; then
  ARGS+=(--api-key "$MEGA_INFERENCE_API_KEY")
fi

LORA_MODULES=()
add_lora() {
  local served_name="$1"
  local env_name="$2"
  local adapter_dir="${!env_name:-}"
  if [[ -n "$adapter_dir" && -d "$adapter_dir" ]]; then
    LORA_MODULES+=("$served_name=$adapter_dir")
  fi
}

add_lora "mega-director" "MEGA_DIRECTOR_ADAPTER_DIR"
add_lora "mega-chat" "MEGA_CHAT_ADAPTER_DIR"
add_lora "mega-build" "MEGA_BUILD_ADAPTER_DIR"
add_lora "mega-scripting" "MEGA_SCRIPTING_ADAPTER_DIR"
add_lora "mega-ui" "MEGA_UI_ADAPTER_DIR"
add_lora "mega-fx" "MEGA_FX_ADAPTER_DIR"
add_lora "mega-gameplay" "MEGA_GAMEPLAY_ADAPTER_DIR"
add_lora "mega-qa" "MEGA_QA_ADAPTER_DIR"

if (( ${#LORA_MODULES[@]} > 0 )); then
  ARGS+=(--enable-lora --max-loras 8 --max-lora-rank "${MEGA_MAX_LORA_RANK:-64}")
  ARGS+=(--lora-modules "${LORA_MODULES[@]}")
fi

echo "Starting MEGA inference server with base model: $BASE_MODEL"
echo "Loaded specialist adapters: ${#LORA_MODULES[@]}"
exec vllm "${ARGS[@]}"
