import logoColorUrl from "../../../../assets/pult/logo-color.svg?url";
import logoWhiteUrl from "../../../../assets/pult/logo-white.svg?url";
import { APP_BASE_NAME } from "../branding";

/** Pult's wordmark: in colour, and black and white in dev, as the dev app icon is. */
export function PultLogo({ className }: { readonly className?: string }) {
  return (
    <img
      src={import.meta.env.DEV ? logoWhiteUrl : logoColorUrl}
      alt={APP_BASE_NAME}
      className={className}
    />
  );
}
