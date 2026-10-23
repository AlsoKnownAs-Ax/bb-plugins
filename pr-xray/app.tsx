// PR X-ray frontend: the review page (nav panel), the palette command and its
// dialog, and the settings section.
import { definePluginApp, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { parsePrSubPath, REVIEW_PANEL_PATH } from "./shared/pr-ref";
import { HomePage } from "./ui/HomePage";
import { OpenPrDialog } from "./ui/OpenPrDialog";
import { ReviewPage } from "./ui/ReviewPage";
import { SettingsSection } from "./ui/SettingsSection";
import { uiStore } from "./ui/store";

function ReviewPanel({ subPath }: PluginNavPanelProps) {
  const ref = parsePrSubPath(subPath);
  if (ref === null) return <HomePage />;
  return <ReviewPage key={subPath} prRef={ref} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "review",
    title: "PR X-ray",
    icon: "GitPullRequest",
    path: REVIEW_PANEL_PATH,
    component: ReviewPanel,
  });
  app.slots.experimental_appOverlay({ id: "open-pr", component: OpenPrDialog });
  app.commands.register({
    id: "review-pr",
    title: "PR X-ray: Review a pull request",
    defaultShortcut: { key: "x", mod: true, shift: true },
    run: () => uiStore.set({ openDialog: true }),
  });
  app.slots.settingsSection({
    id: "analysis",
    title: "Connection and model",
    component: SettingsSection,
  });
});
