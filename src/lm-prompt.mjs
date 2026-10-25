/**
 * Runs a prompt through VS Code's Language Model API.
 *
 * This is the editor's own Copilot plumbing: authentication, model choice and
 * quota come from the editor, so no token and no CLI are needed. The trade-off
 * against `workbench.action.chat.open` is that the run is not a Chat-list
 * session — what you gain is a reply we can actually deliver to Telegram, and
 * tokens as they stream.
 */

/**
 * @typedef {object} LmSessionOptions
 * @property {any} lm the `vscode.lm` namespace
 * @property {(text: string) => void} [onChunk] called as text arrives
 * @property {string} [modelId] preferred model id; the first match is used otherwise
 * @property {string} [modelFamily] preferred family, e.g. `gpt-4o`
 * @property {any} [CancellationToken] injected for tests
 */

function collectText(chunk) {
  if (!chunk) return '';
  if (typeof chunk === 'string') return chunk;
  // LanguageModelTextPart / LanguageModelDataPart across versions.
  if (typeof chunk.value === 'string') return chunk.value;
  if (chunk.text !== undefined) return String(chunk.text);
  return '';
}

/**
 * @param {LmSessionOptions & { prompt: string }} options
 * @returns {Promise<{ ok: boolean, text: string, model?: string, error?: string }>}
 */
export async function runWithLanguageModel({ lm, prompt, onChunk, modelId, modelFamily }) {
  const text = String(prompt ?? '').trim();
  if (!text) return { ok: false, text: '', error: 'the prompt is empty' };
  if (!lm || typeof lm.selectChatModels !== 'function') {
    return { ok: false, text: '', error: 'the VS Code language model API is not available' };
  }

  let models;
  try {
    models = await lm.selectChatModels(modelId ? { id: modelId } : modelFamily ? { family: modelFamily } : {});
  } catch (err) {
    return { ok: false, text: '', error: `could not list models: ${err?.message || err}` };
  }
  if (!Array.isArray(models) || !models.length) {
    return {
      ok: false,
      text: '',
      error: 'no Copilot model is available — sign in to Copilot Chat, or use the chat mode instead',
    };
  }

  const model = models[0];
  // Optional consent check: some builds require the user to allow this extension.
  try {
    const allowed = await lm?.accessInformation?.canSendRequest?.(model);
    if (allowed === false) {
      return { ok: false, text: '', error: 'VS Code has not granted this extension access to the model' };
    }
  } catch {
    /* older builds have no consent API */
  }

  const messages = [{ role: 1, content: text }];
  let answer = '';
  try {
    const response = await model.sendRequest(messages, {}, new AbortControllerSignal());
    for await (const chunk of response.stream ?? response.text ?? []) {
      const piece = collectText(chunk);
      if (!piece) continue;
      answer += piece;
      try {
        onChunk?.(piece);
      } catch {
        /* a progress callback must not break the run */
      }
    }
  } catch (err) {
    return { ok: false, text: answer, model: model.id, error: err?.message || String(err) };
  }

  return { ok: true, text: answer.trim(), model: model.id };
}

/** Minimal CancellationToken stand-in; VS Code's real one is optional here. */
class AbortControllerSignal {
  constructor() {
    this.isCancellationRequested = false;
    this._listeners = [];
  }
  onCancellationRequested(listener) {
    this._listeners.push(listener);
    return { dispose: () => {} };
  }
  dispose() {}
}
