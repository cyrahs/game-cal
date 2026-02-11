import { Route, Routes } from "react-router-dom";
import { PrefsProvider } from "./context/prefs";
import Shell from "./components/Shell";
import GamePage from "./pages/GamePage";

export default function App() {
  return (
    <PrefsProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route path="/" element={<GamePage key="genshin" game="genshin" />} />
          <Route path="/starrail" element={<GamePage key="starrail" game="starrail" />} />
          <Route path="/ww" element={<GamePage key="ww" game="ww" />} />
          <Route path="/zzz" element={<GamePage key="zzz" game="zzz" />} />
          <Route path="/snowbreak" element={<GamePage key="snowbreak" game="snowbreak" />} />
          <Route path="/endfield" element={<GamePage key="endfield" game="endfield" />} />
          <Route path="*" element={<GamePage key="genshin" game="genshin" />} />
        </Route>
      </Routes>
    </PrefsProvider>
  );
}
