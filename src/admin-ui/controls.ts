import { escapeHtml } from "./escape";

// Shared form-control renderers for the admin UI. They keep the underlying
// native inputs (`name`, `x-model`) byte-identical to the old markup so the
// settings POST contract is unchanged — only the surrounding chrome changes.

// A dot-separated identifier path (e.g. "tab", "flags.comments_enabled"): every
// segment must itself be a valid identifier. A looser `[\w$.]*` body would also
// admit malformed paths like `a..b`, `a.`, or `.a`, which defeat the point.
const SAFE_STATE_VAR = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const SAFE_TAB_ID = /^[A-Za-z0-9_-]+$/;

// `model`/`stateVar`/`t.id` are interpolated raw into Alpine *expression*
// strings (x-model / :class / @click), not just HTML text. HTML-escaping them
// is NOT sufficient: the HTML parser decodes entities before Alpine evaluates,
// so an encoded quote would decode back to a real quote and could break out of
// the JS string into an Alpine expression (which runs under script-src
// 'unsafe-eval'). These are always developer-defined constants, so enforce that
// with a strict identifier allowlist — a stray or user-derived value fails
// loudly here instead of injecting silently.
const assertSafeExpr = (label: string, value: string): void => {
	if (!SAFE_STATE_VAR.test(value)) {
		throw new Error(`${label}: unsafe expression ${JSON.stringify(value)}`);
	}
};

export type SwitchOpts = {
	/** Native input `name` (also the settings key). */
	name: string;
	/** Alpine x-model expression, e.g. "flags.comments_enabled". */
	model: string;
	label: string;
	help: string;
};

/**
 * A label + help row with a CSS-only toggle switch. The native checkbox is
 * visually hidden but still drives `name`/`x-model`, so form submission and
 * Alpine state work exactly as a bare checkbox would.
 */
export const renderSwitch = ({ name, model, label, help }: SwitchOpts): string => {
	assertSafeExpr("renderSwitch", model);
	return `
<label class="switch-row">
  <span class="switch">
    <input type="checkbox" name="${escapeHtml(name)}" x-model="${model}">
    <span class="switch-track"><span class="switch-thumb"></span></span>
  </span>
  <span class="field-text">
    <strong>${escapeHtml(label)}</strong>
    <span class="muted">${escapeHtml(help)}</span>
  </span>
</label>`;
};

export type StepperOpts = {
	name: string;
	/** Alpine x-model expression, e.g. "nums.comments_per_page". */
	model: string;
	min: number;
	max: number;
	label: string;
	help: string;
};

/**
 * A label + help row with a numeric stepper (− / value / +). The − and +
 * buttons clamp to [min, max] in Alpine; the input keeps the same `name` and
 * `x-model.number` binding as the old bare number input. `model` is interpolated
 * raw into the @click expressions, so it is held to the same identifier
 * allowlist as `renderTabs` (`min`/`max` are numbers and need no guard).
 */
export const renderStepper = ({ name, model, min, max, label, help }: StepperOpts): string => {
	assertSafeExpr("renderStepper", model);
	return `
<div class="field-row">
  <span class="stepper">
    <button type="button" class="stepper-btn" aria-label="Decrease ${escapeHtml(label)}"
            @click="${model} = Math.max(${min}, (Number(${model}) || 0) - 1)">−</button>
    <input type="number" name="${escapeHtml(name)}" min="${min}" max="${max}" step="1"
           x-model.number="${model}">
    <button type="button" class="stepper-btn" aria-label="Increase ${escapeHtml(label)}"
            @click="${model} = Math.min(${max}, (Number(${model}) || 0) + 1)">+</button>
  </span>
  <span class="field-text">
    <strong>${escapeHtml(label)}</strong>
    <span class="muted">${escapeHtml(help)}</span>
  </span>
</div>`;
};

export type TabDef = { id: string; label: string };

/**
 * A tab strip bound to an Alpine state property. `stateVar` is the property on
 * the surrounding x-data scope that holds the active tab id (e.g. "tab").
 */
export const renderTabs = (stateVar: string, tabs: TabDef[]): string => {
	assertSafeExpr("renderTabs", stateVar);
	const buttons = tabs
		.map((t) => {
			if (!SAFE_TAB_ID.test(t.id)) {
				throw new Error(`renderTabs: unsafe tab id ${JSON.stringify(t.id)}`);
			}
			return `
  <button type="button" class="tab" role="tab"
          :class="${stateVar} === '${t.id}' && 'active'"
          :aria-selected="${stateVar} === '${t.id}'"
          @click="${stateVar} = '${t.id}'">${escapeHtml(t.label)}</button>`;
		})
		.join("");
	return `<div class="tabs" role="tablist">${buttons}</div>`;
};
