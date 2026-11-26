// Shared by the server and client entry points, so it must not use Node APIs.

/**
 * The kind of device the user is on when your service opens the BankID app.
 * Detecting it is up to you.
 */
export type StartDevice = "phone" | "desktop";

/** Options for {@link startUrl}. */
export interface StartUrlOptions {
  /** The `autoStartToken` from the order response. */
  autoStartToken: string;
  /** Phone gives a web link the OS routes to the app; desktop a `bankid` link. */
  device: StartDevice;
}

/**
 * The URL that opens the BankID app on the same device for an order, as
 * described in BankID's autostart guide. It never adds a `redirect`
 * parameter: pass the return URL in the order instead.
 */
export function startUrl({ autoStartToken, device }: StartUrlOptions): string {
  if (typeof autoStartToken !== "string" || autoStartToken === "") {
    throw new TypeError("startUrl needs a non-empty autoStartToken");
  }
  const query = `?autostarttoken=${encodeURIComponent(autoStartToken)}`;
  switch (device) {
    case "phone":
      return `https://app.bankid.com/${query}`;
    case "desktop":
      return `bankid:///${query}`;
    default:
      throw new TypeError(
        `startUrl does not know the device "${String(device)}"`,
      );
  }
}
