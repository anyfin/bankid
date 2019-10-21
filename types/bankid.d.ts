export declare type BankIdOptions = {
    production: boolean,
    refreshInterval: number,
    pfx: string,
    passphrase: string,
    ca: string
}

export declare class BankId {

    constructor(options: BankIdOptions);

    authenticate(endUserIp: string, personalNumber: string, requirement: boolean)

    sign(endUserIp: string, personsalNumber: string, userVisibleData: string, userNonVisisbleData: string, requirement: boolean)

    collect(orderRef: string)

    cancel(orderRef: string)

    authenticateAndCollect()

    signAndCollect()
}

