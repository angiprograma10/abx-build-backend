#!/usr/bin/env python3
"""Entrenamiento LoRA reproducible para especialistas MEGA.

No crea inteligencia desde cero: adapta un modelo base abierto con ejemplos
curados. Cada especialista produce un adaptador separado y versionado.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

SPECIALISTS = {
    "mega-director", "mega-build", "mega-scripting", "mega-ui",
    "mega-fx", "mega-gameplay", "mega-chat", "mega-qa",
}
ALLOWED_ROLES = {"system", "user", "assistant"}


@dataclass
class Example:
    specialist: str
    messages: list[dict[str, str]]
    project_id: str = ""
    source: str = ""
    license: str = "original"
    split: str = ""


def fail(message: str) -> None:
    raise SystemExit(f"[MEGA TRAINING] ERROR: {message}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[Example]:
    if not path.exists():
        fail(f"No existe el dataset: {path}")
    rows: list[Example] = []
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        try:
            item = json.loads(raw)
        except json.JSONDecodeError as exc:
            fail(f"{path}:{line_number}: JSON inválido: {exc}")
        if not isinstance(item, dict):
            fail(f"{path}:{line_number}: cada línea debe ser un objeto JSON")
        specialist = item.get("specialist")
        messages = item.get("messages")
        if specialist not in SPECIALISTS:
            fail(f"{path}:{line_number}: especialista desconocido: {specialist!r}")
        if not isinstance(messages, list) or len(messages) < 2:
            fail(f"{path}:{line_number}: messages debe contener al menos 2 mensajes")
        normalized: list[dict[str, str]] = []
        for index, message in enumerate(messages):
            if not isinstance(message, dict):
                fail(f"{path}:{line_number}: mensaje {index} no es objeto")
            role, text = message.get("role"), message.get("content")
            if role not in ALLOWED_ROLES or not isinstance(text, str) or not text.strip():
                fail(f"{path}:{line_number}: mensaje {index} tiene role/content inválido")
            normalized.append({"role": role, "content": text})
        if normalized[-1]["role"] != "assistant":
            fail(f"{path}:{line_number}: el último mensaje debe ser assistant")
        if not any(m["role"] == "user" for m in normalized):
            fail(f"{path}:{line_number}: falta un mensaje user")
        rows.append(Example(
            specialist=specialist,
            messages=normalized,
            project_id=str(item.get("project_id", "")),
            source=str(item.get("source", "")),
            license=str(item.get("license", "unknown")),
            split=str(item.get("split", "")),
        ))
    if not rows:
        fail("El dataset está vacío")
    return rows


def split_by_project(rows: list[Example], seed: int, validation_ratio: float):
    """Separa por proyecto para evitar que variantes casi iguales filtren al test."""
    groups: dict[str, list[Example]] = {}
    for index, row in enumerate(rows):
        key = row.project_id or f"unassigned-{index}"
        groups.setdefault(key, []).append(row)
    keys = list(groups)
    random.Random(seed).shuffle(keys)
    if len(keys) < 2:
        fail("Se necesitan al menos dos project_id distintos para separar train/validation")
    validation_count = max(1, round(len(keys) * validation_ratio))
    validation_keys = set(keys[:validation_count])
    train = [row for key, group in groups.items() if key not in validation_keys for row in group]
    validation = [row for key, group in groups.items() if key in validation_keys for row in group]
    if not train or not validation:
        fail("La división produjo un conjunto vacío")
    return train, validation


def validate_licenses(rows: list[Example]) -> None:
    unsafe = [row for row in rows if not row.license.strip() or row.license == "unknown"]
    if unsafe:
        fail(f"{len(unsafe)} ejemplos no tienen licencia/procedencia declarada")


def encode_example(example: Example, tokenizer, max_length: int) -> dict[str, list[int]] | None:
    messages = example.messages
    target = messages[-1]["content"]
    prompt_messages = messages[:-1]
    prompt = tokenizer.apply_chat_template(
        prompt_messages, tokenize=False, add_generation_prompt=True
    )
    completion = target + (tokenizer.eos_token or "")
    prompt_ids = tokenizer(prompt, add_special_tokens=False)["input_ids"]
    completion_ids = tokenizer(completion, add_special_tokens=False)["input_ids"]
    if len(prompt_ids) + len(completion_ids) > max_length:
        # Preserve the answer; truncate only the oldest prompt tokens.
        budget = max_length - len(completion_ids)
        if budget < 32:
            return None
        prompt_ids = prompt_ids[-budget:]
    input_ids = prompt_ids + completion_ids
    labels = ([-100] * len(prompt_ids)) + completion_ids
    attention_mask = [1] * len(input_ids)
    return {"input_ids": input_ids, "attention_mask": attention_mask, "labels": labels}


def main() -> None:
    parser = argparse.ArgumentParser(description="Entrena un adaptador LoRA de MEGA")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--specialist", required=True, choices=sorted(SPECIALISTS))
    parser.add_argument("--base-model", default=os.getenv("MEGA_BASE_MODEL", "openai/gpt-oss-20b"))
    parser.add_argument("--output", type=Path, default=Path("models"))
    parser.add_argument("--epochs", type=float, default=2.0)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accumulation", type=int, default=16)
    parser.add_argument("--max-length", type=int, default=4096)
    parser.add_argument("--rank", type=int, default=16)
    parser.add_argument("--alpha", type=int, default=32)
    parser.add_argument("--dropout", type=float, default=0.05)
    parser.add_argument("--validation-ratio", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    rows = [row for row in load_jsonl(args.dataset) if row.specialist == args.specialist]
    if len(rows) < 20:
        fail(f"{args.specialist} solo tiene {len(rows)} ejemplos; piloto mínimo recomendado: 20 revisados")
    validate_licenses(rows)
    train_rows, validation_rows = split_by_project(rows, args.seed, args.validation_ratio)
    print(f"Especialista: {args.specialist}")
    print(f"Base: {args.base_model}")
    print(f"Dataset SHA256: {sha256_file(args.dataset)}")
    print(f"Ejemplos: train={len(train_rows)} validation={len(validation_rows)}")
    if args.dry_run:
        print("Dry run correcto. No se descargó ni entrenó ningún modelo.")
        return

    try:
        import torch
        from datasets import Dataset
        from peft import LoraConfig, get_peft_model, TaskType
        from transformers import (
            AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments,
            DataCollatorForSeq2Seq,
        )
    except ImportError as exc:
        fail(f"Falta dependencia de entrenamiento: {exc}. Instala training/requirements.txt")

    if not torch.cuda.is_available():
        fail("No se detectó CUDA. El entrenamiento requiere GPU compatible o una configuración CPU explícita.")

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    def prepare(source: list[Example]) -> Dataset:
        encoded = []
        skipped = 0
        for example in source:
            item = encode_example(example, tokenizer, args.max_length)
            if item is None:
                skipped += 1
            else:
                encoded.append(item)
        if not encoded:
            fail("Todos los ejemplos superan max-length o no dejan espacio para respuesta")
        print(f"Codificados: {len(encoded)}; omitidos por longitud: {skipped}")
        return Dataset.from_list(encoded)

    train_dataset = prepare(train_rows)
    eval_dataset = prepare(validation_rows)
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        torch_dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
        device_map="auto",
        trust_remote_code=True,
    )
    model.config.use_cache = False
    available_modules = {name.split(".")[-1] for name, _ in model.named_modules()}
    candidates = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
    target_modules = [name for name in candidates if name in available_modules]
    if not target_modules:
        fail("No se encontraron módulos LoRA estándar. Revisa la arquitectura del modelo base.")
    lora = LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=args.dropout,
        bias="none", task_type=TaskType.CAUSAL_LM, target_modules=target_modules,
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    output_dir = args.output / args.specialist
    training_args = TrainingArguments(
        output_dir=str(output_dir),
        num_train_epochs=args.epochs,
        learning_rate=args.learning_rate,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=args.grad_accumulation,
        gradient_checkpointing=True,
        evaluation_strategy="epoch",
        save_strategy="epoch",
        logging_steps=10,
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        bf16=torch.cuda.is_bf16_supported(),
        fp16=not torch.cuda.is_bf16_supported(),
        report_to="none",
        seed=args.seed,
        data_seed=args.seed,
    )
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=DataCollatorForSeq2Seq(tokenizer, padding=True, label_pad_token_id=-100),
    )
    trainer.train()
    metrics = trainer.evaluate()
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    manifest = {
        "specialist": args.specialist,
        "base_model": args.base_model,
        "dataset_sha256": sha256_file(args.dataset),
        "train_examples": len(train_dataset),
        "validation_examples": len(eval_dataset),
        "metrics": metrics,
        "lora": {"rank": args.rank, "alpha": args.alpha, "dropout": args.dropout, "target_modules": target_modules},
        "seed": args.seed,
        "status": "trained_pending_benchmark",
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "mega-training-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
