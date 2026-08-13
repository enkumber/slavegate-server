import type {
  WorkflowPostconditionContract,
  WorkflowPostconditionValue,
} from "../workflows/types";

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[key];
  }, root);
}

function resolveValue(root: Record<string, unknown>, ref: WorkflowPostconditionValue | undefined): unknown {
  if (!ref) return undefined;
  if (Object.prototype.hasOwnProperty.call(ref, "value")) return ref.value;
  return typeof ref.path === "string" ? readPath(root, ref.path) : undefined;
}

function normalizedUri(value: unknown, options: { ignoreFragment?: boolean; ignoreTrailingSlash?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  try {
    const uri = new URL(value);
    uri.hostname = uri.hostname.toLowerCase();
    if (options.ignoreFragment !== false) uri.hash = "";
    if (options.ignoreTrailingSlash !== false && uri.pathname !== "/") uri.pathname = uri.pathname.replace(/\/+$/, "");
    return uri.toString();
  } catch {
    return null;
  }
}

export interface PostconditionEvaluation {
  ok: boolean;
  failures: string[];
}

function isPositiveBusinessProof(
  operatorOpcode: number | undefined,
  left: unknown,
  right: unknown,
): boolean {
  switch (operatorOpcode) {
    case 0:
      return left === true;
    case 2:
      return right !== false && right !== null && right !== undefined && Object.is(left, right);
    case 4:
    case 5:
    case 10:
    case 11:
      return true;
    default:
      return false;
  }
}

export function evaluatePostconditionContract(
  contract: WorkflowPostconditionContract,
  context: Record<string, unknown>,
): PostconditionEvaluation {
  if (contract.version !== "1" || !Array.isArray(contract.all) || contract.all.length === 0) {
    return { ok: false, failures: ["postcondition contract is empty or unsupported"] };
  }
  const failures: string[] = [];
  let hasPositiveBusinessProof = false;
  contract.all.forEach((predicate, index) => {
    const left = resolveValue(context, predicate.left);
    const right = resolveValue(context, predicate.right);
    let passed = false;
    switch (predicate.operatorOpcode) {
      case 0: passed = Boolean(left); break;
      case 1: passed = !left; break;
      case 2: passed = Object.is(left, right); break;
      case 3: passed = !Object.is(left, right); break;
      case 4: passed = typeof left === "string" && left.includes(String(right ?? "")); break;
      case 5: passed = typeof left === "string" && left.toLowerCase().includes(String(right ?? "").toLowerCase()); break;
      case 6: passed = typeof left !== "string" || !left.includes(String(right ?? "")); break;
      case 7: passed = typeof left !== "string" || !left.toLowerCase().includes(String(right ?? "").toLowerCase()); break;
      case 8: passed = left !== undefined && left !== null; break;
      case 9: passed = left === undefined || left === null; break;
      case 10:
        try {
          passed = typeof left === "string" && typeof right === "string" && new RegExp(right).test(left);
        } catch {
          passed = false;
        }
        break;
      case 11: {
        const normalizedLeft = normalizedUri(left, predicate.options);
        const normalizedRight = normalizedUri(right, predicate.options);
        const redirects = (predicate.options?.acceptedRedirects ?? [])
          .map((value) => normalizedUri(value, predicate.options))
          .filter((value): value is string => !!value);
        passed = !!normalizedLeft && !!normalizedRight
          && (normalizedLeft === normalizedRight || redirects.includes(normalizedLeft));
        break;
      }
      default:
        failures.push(`predicate ${index} has no PostgreSQL-resolved operator opcode`);
        return;
    }
    if (!passed) failures.push(`predicate ${index} failed (${predicate.operator})`);
    if (passed && isPositiveBusinessProof(predicate.operatorOpcode, left, right)) {
      hasPositiveBusinessProof = true;
    }
  });
  if (failures.length === 0 && !hasPositiveBusinessProof) {
    failures.push("postcondition contract contains no positive business proof");
  }
  return { ok: failures.length === 0, failures };
}
