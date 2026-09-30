/** Wait for an observable async outcome instead of assuming a render/IO duration. */
export async function waitForState(condition: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}
