/**
 * The "are you sure" question for risky actions in the administration area (writing to decoders, disconnecting,
 * switching booster power …). Everyday operation (driving, switching, routes, NOT-HALT) never asks.
 */
export const sure = (message: string): boolean => window.confirm(message);

/** Run `action` only if the user confirms. */
export function ifSure<T>(message: string, action: () => T): T | undefined {
  return sure(message) ? action() : undefined;
}
