export interface DriveCommand {
  readonly operation: string
  readonly value?: string
}

export interface StartOptions {
  readonly kind: "start"
  readonly name: string
  readonly daemon: boolean
  readonly script?: string
  readonly visible: boolean
  readonly record: boolean
  readonly dev?: string
  readonly command: ReadonlyArray<string>
}

export interface SendOptions {
  readonly kind: "send"
  readonly name?: string
  readonly commands: ReadonlyArray<DriveCommand>
}

export type CliOptions = StartOptions | SendOptions
