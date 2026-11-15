/**
 * The "are you sure" question for risky actions (writing to decoders, disconnecting, deleting, emergency release …).
 * Everyday operation (driving, switching, routes, Nothalt) never asks. Every such question goes through here.
 */
export const sure = (message: string): boolean => window.confirm(message);

/** Run `action` only if the user confirms. */
export function ifSure<T>(message: string, action: () => T): T | undefined {
  return sure(message) ? action() : undefined;
}
