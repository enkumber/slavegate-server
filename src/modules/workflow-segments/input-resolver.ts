import type {
  SegmentInputResolver,
  SegmentInputSchema,
  SegmentInputSchemaProperty,
} from "./types";

const MAX_PATTERN_CHARS = 1_000;

function controlledRegex(pattern: string, flags = ""): RegExp {
  if (!pattern || pattern.length > MAX_PATTERN_CHARS) {
    throw Object.assign(new Error("configured input resolver pattern is invalid"), {
      code: "SEGMENT_INPUT_RESOLVER_INVALID",
    });
  }
  if (!/^[gimsuy]*$/.test(flags)) {
    throw Object.assign(new Error("configured input resolver flags are invalid"), {
      code: "SEGMENT_INPUT_RESOLVER_INVALID",
    });
  }
  if (
    /\\[1-9]/.test(pattern)
    || /\(\?[=!<]/.test(pattern)
    || /(?:\*|\+|\{\d+(?:,\d*)?\})\s*(?:\*|\+|\{)/.test(pattern)
  ) {
    throw Object.assign(new Error("configured input resolver pattern uses unsupported regex constructs"), {
      code: "SEGMENT_INPUT_RESOLVER_INVALID",
    });
  }
  return new RegExp(pattern, flags);
}

export function validateInputResolver(resolver: SegmentInputResolver, schema: SegmentInputSchema): void {
  if (!resolver || resolver.version !== "1" || !resolver.fields || typeof resolver.fields !== "object") {
    throw Object.assign(new Error("input resolver is invalid"), {
      status: 422,
      code: "COMPOSITION_INPUT_RESOLVER_INVALID",
    });
  }
  for (const required of schema.required) {
    if (!resolver.fields[required]) {
      throw Object.assign(new Error(`input resolver is missing required field: ${required}`), {
        status: 422,
        code: "COMPOSITION_INPUT_RESOLVER_INVALID",
      });
    }
  }
  for (const [key, field] of Object.entries(resolver.fields)) {
    if (!schema.properties[key]) {
      throw Object.assign(new Error(`input resolver field is not declared in inputSchema: ${key}`), {
        status: 422,
        code: "COMPOSITION_INPUT_RESOLVER_INVALID",
      });
    }
    if (!field || !Array.isArray(field.sources) || field.sources.length === 0) {
      throw Object.assign(new Error(`input resolver field has no sources: ${key}`), {
        status: 422,
        code: "COMPOSITION_INPUT_RESOLVER_INVALID",
      });
    }
    for (const source of field.sources) {
      if (source.kind === "regex") controlledRegex(source.pattern, source.flags);
      else if (source.kind !== "literal") {
        throw Object.assign(new Error(`input resolver source is unsupported: ${key}`), {
          status: 422,
          code: "COMPOSITION_INPUT_RESOLVER_INVALID",
        });
      }
    }
    for (const transform of field.transforms ?? []) {
      if (transform.kind === "prefix_unless") controlledRegex(transform.pattern);
      else if (transform.kind === "replace") controlledRegex(transform.pattern, transform.flags);
      else if (!["trim", "lowercase", "uppercase"].includes(transform.kind)) {
        throw Object.assign(new Error(`input resolver transform is unsupported: ${key}`), {
          status: 422,
          code: "COMPOSITION_INPUT_RESOLVER_INVALID",
        });
      }
    }
  }
}

function applyTransforms(value: unknown, transforms: SegmentInputResolver["fields"][string]["transforms"]): unknown {
  let current = value;
  for (const transform of transforms ?? []) {
    if (typeof current !== "string") {
      throw Object.assign(new Error(`transform ${transform.kind} requires a string`), {
        code: "SEGMENT_INPUT_RESOLUTION_FAILED",
      });
    }
    if (transform.kind === "trim") current = current.trim();
    else if (transform.kind === "lowercase") current = current.toLowerCase();
    else if (transform.kind === "uppercase") current = current.toUpperCase();
    else if (transform.kind === "prefix_unless") {
      if (!controlledRegex(transform.pattern).test(current)) current = `${transform.prefix}${current}`;
    } else if (transform.kind === "replace") {
      current = current.replace(controlledRegex(transform.pattern, transform.flags), transform.replacement);
    }
  }
  return current;
}

function resolveField(intent: string, field: SegmentInputResolver["fields"][string]): unknown {
  for (const source of field.sources) {
    if (source.kind === "literal") return applyTransforms(source.value, field.transforms);
    const match = controlledRegex(source.pattern, source.flags).exec(intent);
    if (match) return applyTransforms(match[source.group ?? 0], field.transforms);
  }
  return undefined;
}

function validProperty(value: unknown, property: SegmentInputSchemaProperty): boolean {
  if (property.type === "string") {
    if (typeof value !== "string") return false;
    if (property.minLength !== undefined && value.length < property.minLength) return false;
    if (property.maxLength !== undefined && value.length > property.maxLength) return false;
    if (property.pattern && !controlledRegex(property.pattern).test(value)) return false;
    if (property.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return false;
    if (property.format === "uri") {
      try {
        const parsed = new URL(value);
        if (!parsed.protocol || !parsed.hostname) return false;
      } catch {
        return false;
      }
    }
  } else if (property.type === "number" && typeof value !== "number") return false;
  else if (property.type === "boolean" && typeof value !== "boolean") return false;
  else if (property.type === "array" && !Array.isArray(value)) return false;
  else if (property.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return false;
  if (property.enum && !property.enum.some((candidate) => Object.is(candidate, value))) return false;
  return true;
}

export function resolveCompositionInputs(
  intent: string,
  resolver: SegmentInputResolver,
  schema: SegmentInputSchema,
): Record<string, unknown> {
  if (resolver.version !== "1" || schema.type !== "object") {
    throw Object.assign(new Error("composition input contract is unsupported"), {
      code: "SEGMENT_INPUT_CONTRACT_UNSUPPORTED",
    });
  }
  validateInputResolver(resolver, schema);
  const inputs = Object.fromEntries(
    Object.entries(resolver.fields)
      .map(([key, field]) => [key, resolveField(intent, field)])
      .filter(([, value]) => value !== undefined),
  );
  for (const required of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(inputs, required)) {
      throw Object.assign(new Error(`required composition input was not resolved: ${required}`), {
        status: 422,
        code: "SEGMENT_INPUT_REQUIRED",
      });
    }
  }
  for (const [key, value] of Object.entries(inputs)) {
    const property = schema.properties[key];
    if (!property) {
      if (schema.additionalProperties === false) {
        throw Object.assign(new Error(`composition input is not allowed: ${key}`), {
          status: 422,
          code: "SEGMENT_INPUT_INVALID",
        });
      }
      continue;
    }
    if (!validProperty(value, property)) {
      throw Object.assign(new Error(`composition input failed schema validation: ${key}`), {
        status: 422,
        code: "SEGMENT_INPUT_INVALID",
      });
    }
  }
  return inputs;
}
