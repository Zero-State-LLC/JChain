/** Raw image input for an encoder: bytes, or a file path where the encoder can read files. */
export type ImageInput = Uint8Array | ArrayBuffer | string;

/**
 * A display WebP ready for JChain, plus its thumbnail when either edge is over 320 px.
 * Both are static WebP with metadata chunks removed.
 */
export type EncodedImage = {
  display: Uint8Array;
  /** Required when either display edge is over 320 px. Ignored otherwise. */
  thumb: Uint8Array | null;
};

/**
 * Turns any image into an {@link EncodedImage}. The core client depends only on this interface,
 * so it runs without `sharp`. Use `sharpEncoder()` in Node, or pass your own.
 */
export interface ImageEncoder {
  encode(input: ImageInput): Promise<EncodedImage>;
}

/** An encoder that always returns the same pre-encoded bytes. Useful in tests and in runtimes without sharp. */
export function staticEncoder(image: EncodedImage): ImageEncoder {
  return { encode: async () => image };
}

export function isEncodedImage(value: unknown): value is EncodedImage {
  return typeof value === "object"
    && value !== null
    && (value as { display?: unknown }).display instanceof Uint8Array
    && "thumb" in value;
}
