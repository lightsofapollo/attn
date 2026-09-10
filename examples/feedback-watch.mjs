#!/usr/bin/env node

// Minimal provider-neutral host adapter for `attn feedback --watch`.
// It keeps the latest record per feedback ID and prints the scheduling events
// a model host needs. It intentionally does not call a model or edit files.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const scope = process.argv[2] ?? '.';
const child = spawn('attn', ['feedback', scope, '--watch'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
const current = new Map();

function emit(kind, feedback, extra = {}) {
  process.stdout.write(`${JSON.stringify({
    kind,
    id: feedback.id,
    feedbackRevision: feedback.feedbackRevision,
    sourceRevision: feedback.sourceRevision ?? null,
    path: feedback.source.path,
    ...extra,
  })}\n`);
}

function installSnapshot(snapshot, reason) {
  current.clear();
  for (const feedback of snapshot.feedback) {
    current.set(feedback.id, feedback);
    emit('actionable', feedback, { reason });
  }
}

function apply(record) {
  switch (record.type) {
    case 'snapshot':
      if (!record.complete) throw new Error('attn returned an incomplete initial snapshot');
      installSnapshot(record.snapshot, 'initial_snapshot');
      return;
    case 'reset':
      installSnapshot(record.snapshot, 'stream_reset');
      return;
    case 'remove':
      current.delete(record.id);
      process.stdout.write(`${JSON.stringify({
        kind: 'removed',
        id: record.id,
        feedbackRevision: record.feedbackRevision,
        reason: record.reason,
      })}\n`);
      return;
    case 'upsert': {
      const feedback = record.feedback;
      const previous = current.get(feedback.id);
      current.set(feedback.id, feedback);
      if (!previous || feedback.feedbackRevision > previous.feedbackRevision) {
        emit('actionable', feedback, { reason: record.reason });
      } else if (feedback.sourceRevision !== previous.sourceRevision) {
        emit('source_context_changed', feedback, { reason: record.reason });
      }
      return;
    }
    default:
      throw new Error(`unknown feedback record type: ${String(record.type)}`);
  }
}

const lines = readline.createInterface({ input: child.stdout });
lines.on('line', (line) => {
  try {
    const record = JSON.parse(line);
    if (record.schema !== 'attn.feedback.v1') {
      throw new Error(`unsupported feedback schema: ${String(record.schema)}`);
    }
    apply(record);
  } catch (error) {
    console.error(`feedback-watch: ${error instanceof Error ? error.message : String(error)}`);
    child.kill('SIGTERM');
    process.exitCode = 1;
  }
});
child.on('exit', (code, signal) => {
  if (process.exitCode) return;
  if (signal) console.error(`feedback-watch: attn exited after ${signal}`);
  process.exitCode = code ?? 1;
});
