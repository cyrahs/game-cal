import { Route, Routes } from "react-router-dom";
import { PrefsProvider } from "./context/prefs";
import Shell from "./components/Shell";
import HomePage from "./pages/HomePage";
import GamePage from "./pages/GamePage";

export default function App() {
  return (
    <PrefsProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/genshin" element={<GamePage game="genshin" />} />
          <Route path="/starrail" element={<GamePage game="starrail" />} />
          <Route path="/ww" element={<GamePage game="ww" />} />
          <Route path="/zzz" element={<GamePage game="zzz" />} />
          <Route path="/snowbreak" element={<GamePage game="snowbreak" />} />
          <Route path="/endfield" element={<GamePage game="endfield" />} />
          <Route path="*" element={<HomePage />} />
        </Route>
      </Routes>
    </PrefsProvider>
  );
}
