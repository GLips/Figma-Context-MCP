import { round } from "remeda";

/**
 * Calculate the size of a string in kilobytes
 * @param text - The string to calculate the size of
 * @returns The size of the string in kilobytes
 */
export function calcStringSize(text: string) {
  const encoder = new TextEncoder();
  const utf8Bytes = encoder.encode(text);
  return round(utf8Bytes.length / 1024, 2);
}