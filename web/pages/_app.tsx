import type { AppProps } from "next/app";
import Head from "next/head";
import "../styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Citation Atlas</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="3D citation galaxy of the top 10,000 most-cited papers"
        />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
