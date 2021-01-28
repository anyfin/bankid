import { BankIdClient } from "bankid";

const DELAY_BETWEEN_REQUETS = 10000; // milliseconds

async function main() {
  const ip = process.argv[2];
  const personalNumber = process.argv[3];

  if (!ip || !personalNumber) {
    console.log(
      "Please provide an IP and personal number connected to a test BankId: `yarn test <ip> <pon>`",
    );
    process.exit(1);
  }

  const client = new BankIdClient({
    production: false,
  });

  try {
    console.log("starting to test /auth");
    const authRequest = await client.authenticate({
      endUserIp: ip,
      personalNumber: personalNumber,
    });

    console.log(authRequest);
    await client._awaitPendingCollect(authRequest.orderRef);
    console.log("auth request successful");
  } catch (e) {
    console.log(e);
  }

  await delay(DELAY_BETWEEN_REQUETS);

  try {
    console.log("starting to test /sign");

    const signRequest = await client.sign({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a test",
    });

    console.log(signRequest);
    await client._awaitPendingCollect(signRequest.orderRef);
    console.log("sign request successful");
  } catch (e) {
    console.log(e);
  }

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /auth and /collect");

  client
    .authenticateAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
    })
    .then(() => console.log("authenticateAndCollect successful"))
    .catch(console.log);

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /sign and /collect");

  client
    .signAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a second test",
    })
    .then(() => {
      console.log("signAndCollect successful");
    })
    .catch(console.log);

  await delay(DELAY_BETWEEN_REQUETS);

  try {
    console.log("starting to test /sign and /cancel");

    const response = await client.sign({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData:
        "this is a cancellation test - please DO NOT fill in your verification code",
    });

    await cancelOrderIn(client, response.orderRef, 5000);
  } catch (e) {
    console.log(e);
  }
}

main()
  .then(() => console.log("test completed successfully"))
  .catch(err => console.log(err));

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cancelOrderIn(
  client: BankIdClient,
  orderRef: string,
  ms: number,
) {
  await delay(ms);

  client.cancel({ orderRef });
}
