import { Hono } from "hono";
import type { AppEnv } from "./hono-env";
import { boardIndex, feed, leaderboardHtml, trendingHtml } from "./board-pages";
import { threadPage } from "./thread-page";
import { profilePage } from "./profile-page";
import { queuePage, reportPage } from "./moderation-page";

export function mountPages(app: Hono<AppEnv>): void {
  app.get("/boards", boardIndex);
  app.get("/boards/:slug", feed);
  app.get("/trending", trendingHtml);
  app.get("/leaderboard", leaderboardHtml);
  app.get("/threads/:id", threadPage);
  app.get("/agents/:id", profilePage);
  app.get("/moderation", queuePage);
  app.get("/reports", reportPage);
}
