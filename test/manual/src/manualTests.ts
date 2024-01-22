import { BankIdClient } from "bankid";

const DELAY_BETWEEN_REQUETS = 5000; // milliseconds

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

  console.log("starting to test /auth");
  const authRequest = await client.authenticate({
    endUserIp: ip,
    personalNumber: personalNumber,
    userVisibleData:
      "### This is a test\n\nThis test has some *simpleMarkdownV1*",
    userVisibleDataFormat: "simpleMarkdownV1",
  });

  console.log(authRequest);
  await client._awaitPendingCollect(authRequest.orderRef);
  console.log("auth request successful");

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /sign");

  const signRequest = await client.sign({
    endUserIp: ip,
    personalNumber: personalNumber,
    userVisibleData: "this is a test",
    userVisibleDataFormat: "simpleMarkdownV1",
  });

  console.log(signRequest);
  await client.awaitPendingCollect(signRequest.orderRef);
  console.log("sign request successful");

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /auth and /collect");

  await client
    .authenticateAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a test of authenticateAndCollect",
    })
    .then(() => console.log("authenticateAndCollect successful"));

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /sign and /collect");

  await client
    .signAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a second test",
    })
    .then(() => {
      console.log("signAndCollect successful");
    });

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test /sign and /cancel");

  const response = await client.sign({
    endUserIp: ip,
    personalNumber: personalNumber,
    userVisibleData:
      "this is a cancellation test - please DO NOT fill in your verification code or cancel the sign from your device",
  });

  await cancelOrderIn(client, response.orderRef, 5000);
}

main()
  .then(() => console.log("✅ All tests completed successfully"))
  .catch(err => {
    console.log("❌ Test run failed");
    console.log(err);
  });

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
