import { BankIdClient } from "bankid";

const DELAY_BETWEEN_REQUETS = 5000; // milliseconds

async function main() {
  const ip = process.argv[2];
  const personalNumber = process.argv[3];
  const errors = [];

  if (!ip || !personalNumber) {
    console.log(
      "Please provide an IP and personal number connected to a test BankId: `yarn test <ip> <pon>`",
    );
    process.exit(1);
  }

  const client = new BankIdClient({
    production: false,
  });

  console.log("starting to test authenticate");
  try {
    const authRequest = await client.authenticate({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData:
        "### This is a test\n\nThis test has some *simpleMarkdownV1*",
      userVisibleDataFormat: "simpleMarkdownV1",
    });

    await client._awaitPendingCollect(authRequest.orderRef);
    console.log("authenticate successful");
  } catch (e) {
    console.log("authenticate failed");
    errors.push(e);
  }

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test sign");
  try {
    const signRequest = await client.sign({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a test",
      userVisibleDataFormat: "simpleMarkdownV1",
    });

    await client.awaitPendingCollect(signRequest.orderRef);
    console.log("sign successful");
  } catch (e) {
    console.log("sign failed");
    errors.push(e);
  }

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test authenticateAndCollect");
  await client
    .authenticateAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a test of authenticateAndCollect",
    })
    .then(() => console.log("authenticateAndCollect successful"))
    .catch(e => {
      console.log("authenticateAndCollect failed");
      errors.push(e);
    });

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test signAndCollect");
  await client
    .signAndCollect({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData: "this is a second test",
    })
    .then(() => {
      console.log("signAndCollect successful");
    })
    .catch(e => {
      console.log("signAndCollect failed");
      errors.push(e);
    });

  await delay(DELAY_BETWEEN_REQUETS);

  console.log("starting to test sign and cancel");
  try {
    const response = await client.sign({
      endUserIp: ip,
      personalNumber: personalNumber,
      userVisibleData:
        "this is a cancellation test - please DO NOT fill in your verification code or cancel the sign from your device",
    });

    await cancelOrderIn(client, response.orderRef, 5000);
    console.log("sign and cancel successful");
  } catch (e) {
    console.log("sign and cancel failed");
    errors.push(e);
  }

  return errors;
}

main()
	.then(errors => {
	  const failedTests = errors.length;
	  if (failedTests === 0) {
	    console.log("✅ All tests completed successfully");
	  } else {
	    console.error(`❌ ${failedTests} test(s) failed`);
	  }
	})
	.catch(error => {
		console.error(`❌ test(s) crashed`);
	  console.error(error);
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
