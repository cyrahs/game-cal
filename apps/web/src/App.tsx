import { Navigate, Route, Routes } from "react-router-dom";
import { PrefsProvider } from "./context/prefs";
import Shell from "./components/Shell";
import HomePage from "./pages/HomePage";
import GamePage from "./pages/GamePage";
import { GAME_REGISTRY } from "./lib/games";

export default function App() {
  return (
    <PrefsProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          {GAME_REGISTRY.map((game) => (
            <Route key={game.id} path={game.route} element={<GamePage game={game.id} />} />
          ))}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </PrefsProvider>
  );
}
