export interface DebouncedTrigger {
	(): void;
	cancel(): void;
}

export function createDebouncedTrigger(callback: () => void, delayMs: number): DebouncedTrigger {
	let timer: NodeJS.Timeout | null = null;

	const trigger = (() => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			callback();
		}, Math.max(0, delayMs));
	}) as DebouncedTrigger;

	trigger.cancel = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = null;
	};

	return trigger;
}
