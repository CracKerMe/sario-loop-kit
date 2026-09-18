import { Button } from "@loopkit/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  return (
    <div className="container mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Loopkit</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Self-hostable lifecycle marketing engine. Journeys compile to a real workflow engine —
        durable waits, event wake-ups, and email with idempotent sends.
      </p>
      <div className="mt-6 flex gap-2">
        <Button
          onClick={() => {
            window.location.href = "/dashboard";
          }}
        >
          Open dashboard
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            window.location.href = "/login";
          }}
        >
          Sign in
        </Button>
      </div>
    </div>
  );
}
