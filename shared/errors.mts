import { isRecord } from './json.mjs';

export const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value);
export const errorName = (value: unknown): unknown => isRecord(value) ? value.name : undefined;
export const errorDetails = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
