type NativeGlassHeaderItem = {
  readonly type: "button" | "menu";
  readonly glassEffect?: boolean;
  readonly sharesBackground?: boolean;
  readonly variant?: "plain" | "done" | "prominent";
  readonly width?: number;
};

export const NATIVE_GLASS_HEADER_BUTTON_WIDTH = 58;

/**
 * iOS 26/27 Mail-style header controls need the native glass button
 * configuration when they are not part of a larger toolbar. Keep this
 * centralized so Expo Router screens and plain react-native-screens demos
 * don't drift apart.
 */
export function withNativeGlassHeaderItem<T extends NativeGlassHeaderItem>(
  item: T,
  options: {
    readonly sharesBackground?: boolean;
    readonly width?: number;
  } = {},
): T {
  return {
    ...item,
    glassEffect: item.glassEffect ?? true,
    sharesBackground: options.sharesBackground ?? item.sharesBackground ?? true,
    variant: item.variant ?? "prominent",
    width: options.width ?? item.width ?? NATIVE_GLASS_HEADER_BUTTON_WIDTH,
  } as T;
}
