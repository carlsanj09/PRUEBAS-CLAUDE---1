# Partículas y sonido

Visualización de 1000 partículas contenidas en un rectángulo. El volumen captado
por el micrófono del dispositivo controla la energía del sistema: con silencio
las partículas flotan libremente sin interactuar entre sí, y al detectar sonido
se activan las colisiones físicas (elásticas) entre partículas, además de
rebotar siempre contra los bordes del rectángulo.

El audio se procesa enteramente en el navegador (Web Audio API); no se graba
ni se envía a ningún servidor.

## Desarrollo

```bash
npm install
npm run dev
```

Abre la URL indicada por Vite y pulsa "Activar micrófono" (requiere permiso
del navegador y, en producción, servirse sobre HTTPS o localhost).

## Cómo funciona

- `src/particles/ParticleSystem.js`: simulación física (integración, rebote en
  los bordes, detección de colisiones por grilla espacial, resolución elástica).
- `src/audio/MicVolumeMeter.js`: captura de micrófono y cálculo de volumen (RMS)
  vía `AnalyserNode`.
- `src/ParticleField.jsx`: conecta el canvas, el bucle de animación
  (`requestAnimationFrame`) y el medidor de volumen.
