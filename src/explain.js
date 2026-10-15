/*
 * "Explain this error": a short explanation of why a code block failed and a
 * fixed version of the code.
 *
 * Providers, cheapest first:
 *   apple   — Apple Intelligence's on-device model (free, private, ~4 s)
 *   ollama  — a local model served by Ollama (free, private)
 *   claude  — Claude Haiku 5.5 through the Anthropic API (needs an API key)
 *   copy    — no model: copy a ready prompt and open claude.ai
 */

import { Platform } from "obsidian";
import APPLE_HELPER_SOURCE from "./apple-llm.swift";
import { fs, path, os, childProcess, http } from "./node";

const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

const INSTRUCTIONS = [
  "You help a student understand why a code block in their notes failed.",
  "Reply in Markdown with exactly these parts:",
  "**What went wrong** — one or two plain sentences pointing at the line that failed.",
  "**Why** — the concept behind it, in one or two sentences.",
  "**Fix** — the corrected program as one complete fenced code block in the same language, ready to run.",
  "Keep the prose under 120 words. Don't repeat the error message.",
  "If the code is fine and the problem is the environment (a missing package or compiler), say how to fix that instead and leave out the code block.",
].join("\n");

// Apple's on-device model has a small context window; keep its prompt compact.
const APPLE_CHAR_BUDGET = 7000;

function buildPrompt({ label, code, output, exitCode }, budget = Infinity) {
  let codeText = code;
  let outText = output.trim() || "(no output)";
  const notes = [];
  if (codeText.length + outText.length > budget) {
    const outBudget = Math.max(1500, Math.floor(budget * 0.4));
    if (outText.length > outBudget) {
      outText = "…" + outText.slice(-outBudget);
      notes.push(`The output was trimmed to its last ${outBudget} characters.`);
    }
    const codeBudget = Math.max(1500, budget - outText.length);
    if (codeText.length > codeBudget) {
      codeText = codeText.slice(0, codeBudget) + "\n…";
      notes.push(`The code was trimmed to its first ${codeBudget} characters.`);
    }
  }
  const fence = "````";
  return [
    `This ${label} code block failed${exitCode != null ? ` (exit code ${exitCode})` : ""}.`,
    "",
    "Code:",
    `${fence}${label.toLowerCase()}`,
    codeText,
    fence,
    "",
    "Output:",
    fence,
    outText,
    fence,
    ...(notes.length ? ["", ...notes] : []),
  ].join("\n");
}

/* ------------------------------------------------------------------------ */

class Explainer {
  constructor(plugin) {
    this.plugin = plugin;
    this.appleHelper = null;
    this.appleState = null; // null | "ready" | "unavailable"
  }

  get settings() {
    return this.plugin.settings;
  }

  /* ---------- provider discovery ---------- */

  apiKey() {
    const store = this.plugin.app.secretStorage;
    const id = this.settings.claudeSecretId || "anthropic-api-key";
    let key = null;
    try {
      key = store && store.getSecret(id);
    } catch {
      // no secret storage in this version of Obsidian
    }
    return key || process.env.ANTHROPIC_API_KEY || null;
  }

  // Node's http rather than fetch: no CORS rules to satisfy on localhost.
  ollamaModels() {
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port: 11434, path: "/api/tags", timeout: 1500 }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          try {
            resolve((JSON.parse(body).models || []).map((m) => ({ name: m.name, size: m.size || 0 })));
          } catch {
            resolve([]);
          }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve([]));
    });
  }

  // Prefer a mid-sized general or coding model: fast enough, good enough.
  pickOllamaModel(models) {
    if (this.settings.ollamaModel && models.some((m) => m.name === this.settings.ollamaModel)) return this.settings.ollamaModel;
    if (!models.length) return null;
    const scored = models
      .filter((m) => !/embed/i.test(m.name))
      .map((m) => {
        const gb = m.size / 1e9;
        let score = -Math.abs(gb - 5);
        if (/coder|code/i.test(m.name)) score += 3;
        if (/qwen|llama|gemma|mistral|deepseek|phi/i.test(m.name)) score += 1;
        return { name: m.name, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].name : null;
  }

  async ensureAppleHelper() {
    if (!Platform.isMacOS) return null;
    if (this.appleState === "unavailable") return null;
    if (this.appleHelper && fs.existsSync(this.appleHelper)) return this.appleHelper;
    const dir = path.join(os.homedir(), "Library", "Caches", "tahoe-run");
    const bin = path.join(dir, "tahoe-apple-llm-v1");
    if (fs.existsSync(bin)) {
      this.appleHelper = bin;
      return bin;
    }
    await fs.promises.mkdir(dir, { recursive: true });
    const src = path.join(dir, "tahoe-apple-llm.swift");
    await fs.promises.writeFile(src, APPLE_HELPER_SOURCE);
    const ok = await new Promise((resolve) => {
      childProcess.execFile("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-O", src, "-o", bin], { timeout: 120000 }, (error) => resolve(!error));
    });
    if (!ok) {
      this.appleState = "unavailable";
      return null;
    }
    this.appleHelper = bin;
    return bin;
  }

  async availableProviders() {
    const list = [];
    if (Platform.isMacOS && this.appleState !== "unavailable") list.push("apple");
    const models = await this.ollamaModels();
    if (models.length) list.push("ollama");
    if (this.apiKey()) list.push("claude");
    list.push("copy");
    return { list, models };
  }

  async chooseProvider(preferred) {
    const { list, models } = await this.availableProviders();
    const wanted = preferred || this.settings.explainProvider || "auto";
    if (wanted !== "auto" && list.includes(wanted)) return { provider: wanted, models };
    return { provider: list[0], models };
  }

  /* ---------- running ---------- */

  // onText(delta) streams the answer; resolves with { text, provider, model }.
  async explain(details, { preferred, onText, onStatus, signal } = {}) {
    let { provider, models } = await this.chooseProvider(preferred);

    if (provider === "apple") {
      onStatus && onStatus("Asking Apple Intelligence…");
      const helper = await this.ensureAppleHelper();
      if (helper) {
        try {
          const text = await this.runApple(helper, buildPrompt(details, APPLE_CHAR_BUDGET), onText, signal);
          return { text, provider, model: "Apple Intelligence" };
        } catch (error) {
          if (signal && signal.aborted) throw error;
          // Fall through to the next provider (e.g. Apple Intelligence turned off).
          onText && onText(`\n\n_Apple Intelligence couldn't answer (${error.message}). Trying another model…_\n\n`);
        }
      }
      provider = models.length ? "ollama" : this.apiKey() ? "claude" : "copy";
    }

    if (provider === "ollama") {
      const model = this.pickOllamaModel(models);
      onStatus && onStatus(`Asking ${model} (Ollama)…`);
      const text = await this.runOllama(model, buildPrompt(details), onText, signal);
      return { text, provider, model };
    }

    if (provider === "claude") {
      const model = this.settings.claudeModel || DEFAULT_CLAUDE_MODEL;
      onStatus && onStatus("Asking Claude…");
      const text = await this.runClaude(model, buildPrompt(details), onText, signal);
      return { text, provider, model };
    }

    // No model available: hand the prompt to claude.ai.
    const prompt = `${INSTRUCTIONS}\n\n${buildPrompt(details)}`;
    await navigator.clipboard.writeText(prompt);
    window.open("https://claude.ai/new");
    return { text: null, provider: "copy", model: null };
  }

  runApple(helper, prompt, onText, signal) {
    return new Promise((resolve, reject) => {
      const child = childProcess.spawn(helper, [], { env: Object.assign({}, process.env, { TAHOE_INSTRUCTIONS: INSTRUCTIONS }) });
      let text = "";
      let err = "";
      const abort = () => child.kill("SIGTERM");
      if (signal) signal.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (d) => {
        const s = d.toString();
        text += s;
        onText && onText(s);
      });
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (signal) signal.removeEventListener("abort", abort);
        if (signal && signal.aborted) return reject(new Error("Stopped"));
        if (code === 0 && text.trim()) resolve(text);
        else {
          if (code === 2) this.appleState = "unavailable";
          reject(new Error((err.trim().split("\n").pop() || `exit code ${code}`).replace(/^Apple Intelligence (error|model unavailable): /, "")));
        }
      });
      child.stdin.end(prompt);
    });
  }

  runOllama(model, prompt, onText, signal) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        stream: true,
        think: false,
        messages: [
          { role: "system", content: INSTRUCTIONS },
          { role: "user", content: prompt },
        ],
      });
      const req = http.request(
        { host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          if (res.statusCode !== 200) {
            let e = "";
            res.on("data", (d) => (e += d));
            res.on("end", () => reject(new Error(`Ollama: ${e.slice(0, 200) || res.statusCode}`)));
            return;
          }
          let buffer = "";
          let text = "";
          res.on("data", (d) => {
            buffer += d.toString();
            let nl;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                const piece = (msg.message && msg.message.content) || "";
                if (piece) {
                  text += piece;
                  onText && onText(piece);
                }
                if (msg.error) reject(new Error(`Ollama: ${msg.error}`));
              } catch {
                // part of a line; the rest comes in the next chunk
              }
            }
          });
          res.on("end", () => resolve(text));
        }
      );
      req.on("error", (e) => reject(new Error(`Ollama isn't reachable (${e.message})`)));
      if (signal) signal.addEventListener("abort", () => req.destroy(new Error("Stopped")), { once: true });
      req.end(body);
    });
  }

  async runClaude(model, prompt, onText, signal) {
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error("Add a Claude API key in Settings → Tahoe Run to use Claude.");
    // Anthropic's SDK loads only when Claude is chosen.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    const stream = client.messages.stream(
      {
        model,
        max_tokens: 16000,
        system: INSTRUCTIONS,
        messages: [{ role: "user", content: prompt }],
      },
      { signal }
    );
    stream.on("text", (delta) => onText && onText(delta));
    try {
      const message = await stream.finalMessage();
      if (message.stop_reason === "refusal") throw new Error("Claude declined to answer this one.");
      return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new Error("Claude rejected the API key. Check it in Settings → Tahoe Run.");
      if (error instanceof Anthropic.PermissionDeniedError) throw new Error("This API key doesn't have access to that model.");
      if (error instanceof Anthropic.RateLimitError) throw new Error("Claude is rate-limiting requests. Try again in a moment.");
      if (error instanceof Anthropic.APIError) throw new Error(`Claude API error ${error.status || ""}: ${error.message}`);
      throw error;
    }
  }
}

// First complete fenced block in a reply (the suggested fix).
function extractFix(markdown) {
  if (!markdown) return null;
  const m = /(^|\n)(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\2[ \t]*(\n|$)/.exec(markdown);
  return m ? m[3] : null;
}

export { Explainer, extractFix, buildPrompt, INSTRUCTIONS, DEFAULT_CLAUDE_MODEL };
