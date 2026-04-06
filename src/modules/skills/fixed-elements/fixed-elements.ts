import * as fs from "fs";
import * as path from "path";
import * as path_1 from "path";

export interface FixedElementConfig {
  fixed: boolean;
  note?: string;
}

export interface FixedElementsRegistry {
  description: string;
  elements: Record<string, FixedElementConfig>;
  dynamic: string[];
}

const registryCache: Record<string, FixedElementsRegistry> = {};

export function loadFixedElements(appId: string): FixedElementsRegistry | null {
  if (registryCache[appId]) {
    return registryCache[appId];
  }

  const registryPath = path.join(__dirname, "fixed-elements", `${appId}.json`);
  
  if (!fs.existsSync(registryPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(registryPath, "utf8");
    const registry = JSON.parse(content) as FixedElementsRegistry;
    registryCache[appId] = registry;
    return registry;
  } catch (err) {
    console.error(`[fixed-elements] Failed to load registry for ${appId}:`, err);
    return null;
  }
}

export function isElementFixed(appId: string, elementName: string): boolean {
  const registry = loadFixedElements(appId);
  if (!registry) {
    return false; // Unknown app, don't save
  }

  // Exact match
  if (registry.elements[elementName] !== undefined) {
    return registry.elements[elementName].fixed;
  }

  // Case-insensitive match
  const lower = elementName.toLowerCase();
  for (const [key, config] of Object.entries(registry.elements)) {
    if (key.toLowerCase() === lower) {
      return config.fixed;
    }
  }

  return false; // Element not in registry = don't save (be conservative)
}

export function clearRegistryCache(): void {
  for (const key of Object.keys(registryCache)) {
    delete registryCache[key];
  }
}
