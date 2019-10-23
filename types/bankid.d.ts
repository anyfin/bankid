export interface BankIdSettings {
    production: boolean,
    refreshInterval: number,
    pfx: string,
    passphrase: string,
    ca: string
}

export class BankId {

    constructor(options: BankIdSettings);

    authenticate(endUserIp: string, personalNumber: string, requirement: boolean)

    sign(endUserIp: string, personalNumber: string, userVisibleData: string, userNonVisisbleData: string, requirement: boolean)

    collect(orderRef: string)

    cancel(orderRef: string)

    authenticateAndCollect()

    signAndCollect()
}


