import Head from 'expo-router/head';

import { useScreen } from '@/hooks/use-screen';
import HomeScreen from '@/web/screens/home-screen';

export default function HomeRoute() {
  const screen = useScreen();
  return (
    <>
      <Head>
        <title>Cyfouri · investissement locatif</title>
        <meta name="robots" content="noindex" />
      </Head>
      <HomeScreen {...screen} dom={{ style: { flex: 1 } }} />
    </>
  );
}
