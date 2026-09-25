import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import { assertBuildApiUrl } from './src/config/api-url';

export default defineConfig(({ command, mode }) => {
  // F15-02: una build publicable sin VITE_API_URL (o apuntando a localhost) falla aquí, con un
  // mensaje claro, en vez de generar un bundle que llama a la máquina de quien lo abre.
  assertBuildApiUrl(command, mode, loadEnv(mode, process.cwd(), 'VITE_').VITE_API_URL);

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});
