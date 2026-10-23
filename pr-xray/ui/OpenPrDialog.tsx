// App-wide dialog opened by the palette command; pre-fills a PR link from the clipboard.
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { parsePrRef } from "../shared/pr-ref";
import { useOpenPr } from "./HomePage";
import { uiStore, useUiStore } from "./store";

export function OpenPrDialog() {
  const { openDialog } = useUiStore();
  const openPr = useOpenPr();
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!openDialog) return;
    setError(null);
    setUrl("");
    navigator.clipboard
      ?.readText()
      .then((text) => {
        if (parsePrRef(text) !== null) setUrl(text.trim());
      })
      .catch(() => {
        // Clipboard access denied; the user pastes instead.
      });
  }, [openDialog]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(openPr(url));
  };

  return (
    <Dialog open={openDialog} onOpenChange={(open) => uiStore.set({ openDialog: open })}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Review a pull request</DialogTitle>
            <DialogDescription>Opens the grouped diff and visual explanation in focus mode.</DialogDescription>
          </DialogHeader>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/owner/repo/pull/123" autoFocus />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => uiStore.set({ openDialog: false })}>
              Cancel
            </Button>
            <Button type="submit" disabled={url.trim() === ""}>
              Review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
