import type {
  Node as FigmaDocumentNode,
  Interaction,
  Action,
  Trigger,
  NodeAction,
  Transition,
} from "@figma/rest-api-spec";
import { hasValue } from "~/utils/identity.js";

export interface SimplifiedInteraction {
  trigger: SimplifiedTrigger;
  actions: SimplifiedAction[];
}

export interface SimplifiedTrigger {
  type: string;
  delay?: number;
  timeout?: number;
  keyCodes?: number[];
  device?: string;
  mediaHitTime?: number;
}

export type SimplifiedAction =
  | SimplifiedNavigateAction
  | SimplifiedOpenURLAction
  | SimplifiedBackCloseAction
  | SimplifiedMediaAction
  | SimplifiedSetVariableAction
  | SimplifiedSetVariableModeAction
  | SimplifiedConditionalAction;

export interface SimplifiedNavigateAction {
  type: "NODE";
  destinationId: string | null;
  navigation: string;
  transition?: SimplifiedTransition;
  preserveScrollPosition?: boolean;
  resetScrollPosition?: boolean;
  resetInteractiveComponents?: boolean;
}

export interface SimplifiedOpenURLAction {
  type: "URL";
  url: string;
}

export interface SimplifiedBackCloseAction {
  type: "BACK" | "CLOSE";
}

export interface SimplifiedMediaAction {
  type: "UPDATE_MEDIA_RUNTIME";
  destinationId?: string | null;
  mediaAction: string;
}

export interface SimplifiedSetVariableAction {
  type: "SET_VARIABLE";
  variableId: string | null;
}

export interface SimplifiedSetVariableModeAction {
  type: "SET_VARIABLE_MODE";
  variableCollectionId?: string | null;
  variableModeId?: string | null;
}

export interface SimplifiedConditionalAction {
  type: "CONDITIONAL";
}

export interface SimplifiedTransition {
  type: string;
  duration: number;
  easing?: string;
  direction?: string;
}

/**
 * Extracts prototype interactions from a Figma node.
 * Returns undefined when the node has no interactions.
 *
 * Figma's REST API can return nulls in unexpected places (null triggers, null
 * entries in the actions array, unknown action types), so every access is
 * guarded defensively.
 */
export function buildSimplifiedInteractions(
  node: FigmaDocumentNode,
): SimplifiedInteraction[] | undefined {
  if (!hasValue("interactions", node)) return undefined;

  const raw = node.interactions;
  if (!Array.isArray(raw) || !raw.length) return undefined;

  const result: SimplifiedInteraction[] = [];
  for (const interaction of raw) {
    if (!interaction?.trigger?.type) continue;

    const actions = Array.isArray(interaction.actions) ? interaction.actions : [];
    const simplified = actions.filter(isValidAction).map(simplifyAction);

    result.push({
      trigger: simplifyTrigger(interaction.trigger as Trigger),
      actions: simplified,
    });
  }

  return result.length ? result : undefined;
}

function isValidAction(action: unknown): action is Action {
  return typeof action === "object" && action !== null && "type" in action && action.type != null;
}

function simplifyTrigger(trigger: Trigger): SimplifiedTrigger {
  const result: SimplifiedTrigger = { type: trigger.type };

  if ("delay" in trigger && trigger.delay) result.delay = trigger.delay;
  if ("timeout" in trigger && trigger.timeout) result.timeout = trigger.timeout;
  if ("keyCodes" in trigger) result.keyCodes = trigger.keyCodes;
  if ("device" in trigger) result.device = trigger.device;
  if ("mediaHitTime" in trigger) result.mediaHitTime = trigger.mediaHitTime;

  return result;
}

function simplifyAction(action: Action): SimplifiedAction {
  switch (action.type) {
    case "NODE":
      return simplifyNodeAction(action);
    case "URL":
      return { type: "URL", url: (action as { url: string }).url ?? "" };
    case "BACK":
    case "CLOSE":
      return { type: action.type };
    case "UPDATE_MEDIA_RUNTIME":
      return {
        type: "UPDATE_MEDIA_RUNTIME",
        destinationId: action.destinationId ?? null,
        mediaAction: action.mediaAction,
      };
    case "SET_VARIABLE":
      return { type: "SET_VARIABLE", variableId: action.variableId };
    case "SET_VARIABLE_MODE":
      return {
        type: "SET_VARIABLE_MODE",
        variableCollectionId: action.variableCollectionId,
        variableModeId: action.variableModeId,
      };
    case "CONDITIONAL":
      return { type: "CONDITIONAL" };
    default:
      return { type: (action as { type: string }).type } as SimplifiedAction;
  }
}

function simplifyNodeAction(action: NodeAction): SimplifiedNavigateAction {
  const result: SimplifiedNavigateAction = {
    type: "NODE",
    destinationId: action.destinationId,
    navigation: action.navigation,
  };

  if (action.transition) {
    result.transition = simplifyTransition(action.transition);
  }
  if (action.preserveScrollPosition) result.preserveScrollPosition = true;
  if (action.resetScrollPosition) result.resetScrollPosition = true;
  if (action.resetInteractiveComponents) result.resetInteractiveComponents = true;

  return result;
}

function simplifyTransition(transition: Transition): SimplifiedTransition {
  const result: SimplifiedTransition = {
    type: transition.type,
    duration: transition.duration,
  };

  if (transition.easing?.type) {
    result.easing = transition.easing.type;
  }
  if ("direction" in transition) {
    result.direction = transition.direction;
  }

  return result;
}
