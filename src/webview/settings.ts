/**
 * First-run settings view (Phase 10 — Spike R3 **Outcome D**, in-webview key
 * capture over the live WebSocket).
 *
 * Per the confirmed decision, the API-key/model settings are NOT a separate
 * SDK modal: they are a view rendered inside the persistent streaming SPA,
 * shown in place of the chat on first run (when the host reports `hasKey:
 * false`) and re-openable from the header gear at any time. The key flows ONE
 * WAY — from the input field into the host via `set_config` — and NOTHING ever
 * sends it back. This module receives only `{ hasKey, model }` and, on Save,
 * forwards `(apiKey?, model?)` to {@link onSave}, then immediately clears the
 * input so no key reference lingers in the DOM beyond submission.
 *
 * The `onSave` callback mirrors the `createSink(log, onConfirmResponse?)` seam
 * in `main.ts`: it lets the view stay unit-testable against a bare jsdom
 * container without importing the transport. All dynamic text is set via
 * `.textContent` (never `innerHTML`), so it carries no markup/XSS surface.
 */

/** Non-secret config snapshot the view renders (never carries the key). */
export interface SettingsState {
  /** Whether the host already holds an API key (the key itself never crosses). */
  readonly hasKey: boolean;
  /** The active model id. */
  readonly model: string;
}

/** The handle {@link createSettingsView} returns so `main.ts` can drive it. */
export interface SettingsViewHandle {
  /**
   * Re-render the non-secret status from a fresh {@link SettingsState} (e.g. a
   * later `config_state`): updates the model selection and the "key on file"
   * affordance without touching the in-flight input value.
   *
   * @param state - the latest non-secret config snapshot.
   */
  update(state: SettingsState): void;
  /** Remove the view's DOM and detach its listeners. */
  destroy(): void;
}

/**
 * The model options offered in the select. The host accepts any string, so this
 * stays a minimal, sensible shortlist; the current model is always selectable
 * (added dynamically by {@link createSettingsView} if not already present).
 */
const MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
  { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
];

/**
 * Build the settings view inside `container` and wire its Save seam.
 *
 * Renders, per docs/DESIGN_SYSTEM.md §9: a single sunken masked input for the
 * API key, a model `<select>`, a Save pill (accent when active), and helper
 * text in `--text-secondary` stating the key stays local. Enter in the key
 * field submits Save. On Save it calls `onSave(apiKey || undefined, model)` —
 * omitting an empty key so a model-only change does not clobber an existing key
 * — then clears the input value so no key reference survives in the DOM.
 *
 * @param container - the element to render the form into (its children are
 *   replaced).
 * @param initial - the initial non-secret config snapshot.
 * @param onSave - invoked on Save with the entered key (or `undefined` if blank)
 *   and the selected model. The webview never receives the key back, so this is
 *   the key's only exit point.
 * @returns a {@link SettingsViewHandle} to update or destroy the view.
 */
export function createSettingsView(
  container: HTMLElement,
  initial: SettingsState,
  onSave: (apiKey?: string, model?: string) => void
): SettingsViewHandle {
  container.replaceChildren();

  const form = document.createElement("form");
  form.className = "settings-view";
  form.setAttribute("role", "group");
  form.setAttribute("aria-label", "Agent settings");
  // The form is submitted programmatically (button click / Enter); never let it
  // navigate the page.
  form.noValidate = true;

  // --- Heading ----------------------------------------------------------- //
  const heading = document.createElement("h2");
  heading.className = "settings-heading";
  heading.textContent = "Settings";

  // --- API key field ----------------------------------------------------- //
  const keyField = document.createElement("div");
  keyField.className = "settings-field";

  const keyLabel = document.createElement("label");
  keyLabel.className = "settings-label";
  keyLabel.htmlFor = "settings-api-key";
  keyLabel.textContent = "Anthropic API key";

  const keyInput = document.createElement("input");
  keyInput.id = "settings-api-key";
  keyInput.className = "settings-input";
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.setAttribute("autocapitalize", "off");
  keyInput.setAttribute("autocorrect", "off");
  keyInput.spellcheck = false;

  // The "key on file" affordance: when the host already holds a key, the field
  // is for replacing it, so the placeholder signals a key is stored and an empty
  // submit will not wipe it (empty key → omitted from set_config).
  const setKeyPlaceholder = (hasKey: boolean): void => {
    keyInput.placeholder = hasKey
      ? "A key is on file — type to replace it"
      : "sk-ant-…";
  };
  setKeyPlaceholder(initial.hasKey);

  keyField.append(keyLabel, keyInput);

  // --- Model field ------------------------------------------------------- //
  const modelField = document.createElement("div");
  modelField.className = "settings-field";

  const modelLabel = document.createElement("label");
  modelLabel.className = "settings-label";
  modelLabel.htmlFor = "settings-model";
  modelLabel.textContent = "Model";

  const modelSelect = document.createElement("select");
  modelSelect.id = "settings-model";
  modelSelect.className = "settings-select";

  /** Populate the select, ensuring the active model is always an option. */
  const populateModels = (active: string): void => {
    modelSelect.replaceChildren();
    const seen = new Set<string>();
    const addOption = (value: string, label: string): void => {
      if (seen.has(value)) {
        return;
      }
      seen.add(value);
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      modelSelect.appendChild(option);
    };
    // The active model first, so it is always present and pre-selected even if
    // it is not one of the curated defaults.
    if (active.length > 0) {
      addOption(active, active);
    }
    for (const opt of MODEL_OPTIONS) {
      addOption(opt.value, opt.label);
    }
    modelSelect.value = active.length > 0 ? active : modelSelect.value;
  };
  populateModels(initial.model);

  modelField.append(modelLabel, modelSelect);

  // --- Helper text ------------------------------------------------------- //
  const helper = document.createElement("p");
  helper.className = "settings-helper";
  helper.textContent =
    "Your key is stored locally on your machine and never leaves it.";

  // --- Save button ------------------------------------------------------- //
  const actions = document.createElement("div");
  actions.className = "settings-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.className = "settings-save";
  saveButton.textContent = "Save";

  actions.append(saveButton);

  form.append(heading, keyField, modelField, helper, actions);
  container.appendChild(form);

  // --- Save seam --------------------------------------------------------- //
  /**
   * Forward the entered key + selected model to {@link onSave}, then scrub the
   * input. The key is the only thing that ever leaves; we read it into a local,
   * pass it out, and clear the field — never stored, echoed, or logged.
   */
  const submit = (): void => {
    const rawKey = keyInput.value;
    const apiKey = rawKey.length > 0 ? rawKey : undefined;
    const model = modelSelect.value;
    onSave(apiKey, model);
    // Scrub the key reference from the DOM immediately after handing it off.
    keyInput.value = "";
  };

  const onSubmit = (event: Event): void => {
    event.preventDefault();
    submit();
  };
  form.addEventListener("submit", onSubmit);

  // Focus the key field on first run (no key yet); otherwise focus Save so a
  // re-opened settings view does not steal focus into a sensitive field.
  if (initial.hasKey) {
    saveButton.focus();
  } else {
    keyInput.focus();
  }

  return {
    update(state: SettingsState): void {
      setKeyPlaceholder(state.hasKey);
      populateModels(state.model);
    },
    destroy(): void {
      form.removeEventListener("submit", onSubmit);
      // Defensive scrub before removal in case a key was typed but not saved.
      keyInput.value = "";
      container.replaceChildren();
    },
  };
}
