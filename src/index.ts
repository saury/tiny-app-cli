import { Option, program } from 'commander'
import { ACTION, PLATFORM, description, name, version } from './constants'
import main from './core'

program.name(name).version(version).description(description)
  .addOption(new Option('-p, --platform <platform>', '操作的平台').choices(Object.values(PLATFORM)))
  .addOption(new Option('-a, --action <action>', '提审或者发布').choices(Object.values(ACTION)))

program.parse()

const options = program.opts<InputOptions>()

main(options).catch((err) => {
  console.error(err)
})
