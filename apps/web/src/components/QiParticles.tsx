import { useEffect, useRef, useState } from 'react';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

interface QiParticlesProps {
  rate: number; // qi per second
}

const MAX_PARTICLES = 60;
const PARTICLE_COLOR = '53, 224, 200'; // --spirit RGB

export function QiParticles({ rate }: QiParticlesProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const lastEmitRef = useRef(0);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Track container size
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width: Math.floor(width), height: Math.floor(height) });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || dimensions.width === 0 || dimensions.height === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;

    const animate = (timestamp: number) => {
      ctx.clearRect(0, 0, dimensions.width, dimensions.height);

      // Emit particles based on rate
      if (rate > 0) {
        const emitInterval = 1000 / Math.max(1, rate * 2); // Emit faster when rate is higher
        if (timestamp - lastEmitRef.current > emitInterval && particlesRef.current.length < MAX_PARTICLES) {
          particlesRef.current.push({
            x: Math.random() * dimensions.width,
            y: dimensions.height,
            vx: (Math.random() - 0.5) * 0.5,
            vy: -1 - Math.random() * 2,
            life: 0,
            maxLife: 2000 + Math.random() * 1000,
          });
          lastEmitRef.current = timestamp;
        }
      }

      // Update and draw particles
      particlesRef.current = particlesRef.current.filter((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.life += 16; // ~60fps

        if (p.life >= p.maxLife || p.y < 0) return false;

        const alpha = 1 - p.life / p.maxLife;
        ctx.fillStyle = `rgba(${PARTICLE_COLOR}, ${alpha * 0.6})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fill();

        return true;
      });

      animationId = requestAnimationFrame(animate);
    };

    animationId = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationId);
    };
  }, [rate, dimensions.width, dimensions.height]);

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <canvas
        ref={canvasRef}
        width={dimensions.width}
        height={dimensions.height}
      />
    </div>
  );
}
