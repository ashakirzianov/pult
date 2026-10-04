import type { SVGProps } from "react";

/**
 * Pult's P, cut from the wordmark in `assets/pult/logo-color.svg`, in
 * currentColor: the face solid, its depth faint. It stands where upstream
 * draws its T3 mark at icon size.
 */
export function PultMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="434 587 247 289" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M491.94,587.73h103.98c24.03,0,43.29,12,51.29,31.99l28.79,71.98c8.82,22.1,2.6,50.51-16.2,73.92-18.8,23.43-47.11,38.05-73.66,38.05h-31.99l-19.3,71.98h-71.98l-28.79-71.98,57.87-215.95Z"
        fill="currentColor"
        opacity={0.4}
      />
      <path
        d="M491.94,587.73l-57.87,215.95h71.98l19.3-71.98h31.99c39.75,0,80.6-32.23,91.26-71.98,10.66-39.75-12.94-71.98-52.69-71.98h-103.98Z"
        fill="currentColor"
      />
    </svg>
  );
}
