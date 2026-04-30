let preferredDisplaySourceId: string | null = null;

export function setPreferredDisplaySourceId(id: string | null): void {
  preferredDisplaySourceId = id?.trim() || null;
}

export function getPreferredDisplaySourceId(): string | null {
  return preferredDisplaySourceId;
}
