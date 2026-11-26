import { declineSecret } from "../secrets/model.ts";
import type { PageSecret } from "../secrets/secrets.ts";
import { secretKey } from "./order.ts";
import { age } from "./PanelView.tsx";
import { PosterCard, run } from "./PosterCard.tsx";

/**
 * A secret's row in Inbox, while a thread's agent waits for it
 * (`request_secret`): a poster's row (`PosterCard.tsx`) with a lock and the
 * age of the request where a thread's status sits, giving way on hover to
 * Settle, which declines the secret, and the secret's label as its title. A
 * click opens its poster with the keyboard in the card's input
 * (`pult-shell.openSecret`).
 */
export function SecretCard({
  secret,
  environment,
  now,
}: {
  secret: PageSecret;
  environment: string | undefined;
  now: number;
}) {
  return (
    <PosterCard
      environmentId={secret.environmentId}
      poster={secret.poster}
      environment={environment}
      rowKey={secretKey(secret)}
      title={secret.label}
      slot={
        <span className="pult-card-slot">
          <span className="pult-card-status" title="Secret requested">
            <i className="codicon codicon-lock" aria-label="Secret requested" />{" "}
            {age(secret.since, now)}
          </span>
          {/* Clicks stop here, short of the row that opens the secret. */}
          <span className="pult-card-actions" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              title="Settle: decline the secret"
              onClick={() => void declineSecret(secret)}
            >
              <i className="codicon codicon-check" aria-hidden />
              Settle
            </button>
          </span>
        </span>
      }
      onOpen={() => run("pult-shell.openSecret", secret.environmentId, secret.threadId)}
    />
  );
}
