import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import SimulatorScreen from '@/web/screens/simulator-screen';

export default function SimulatorRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Simulateur · Cyfouri</title>
        <meta name="robots" content="noindex" />
      </Head>
      <SimulatorScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
