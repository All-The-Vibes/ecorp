import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { reviewBlockedReason } from './workflowContext.ts'

const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let card
let eligibility
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'pendingReviewBlockedReason') eligibility = node.initializer
  if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'WorkResultCard' &&
    node.attributes.properties.some(p => p.name?.getText(ast) === 'heading' && p.getText(ast).includes('pendingRun'))) card = node
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(card, 'Exercise the actual mission result summary')
function summary(actor, gate, pendingRun = true) {
  assert.ok(eligibility, 'Summary and decision controls share the existing eligibility helper')
  const pendingReviewBlockedReason = vm.runInNewContext(eligibility.getText(ast), {
    pendingRequest:{gate}, reviewBlockedReason, actorId:actor.id, actorRole:actor.role,
    actors:[actor], mission:{requested_by:'alice'},
  })
  const context = { pendingRun, pendingReviewBlockedReason, pendingActionApprovals: [], mission: {status:'completed'}, exactOrigin:null, deliveredResult:{state:'none'} }
  const read = name => vm.runInNewContext(card.attributes.properties.find(p => p.name?.getText(ast) === name).initializer.expression.getText(ast), context)
  return {heading:read('heading'), description:read('description')}
}
const independent = {type:'independent_review',roles:['owner','member'],exclude_requester:true}
test('requester summary does not ask for a forbidden independent decision', () => {
  const result = summary({id:'alice',name:'Alice',role:'owner'}, independent)
  assert.equal(result.heading, 'Awaiting an eligible reviewer')
  assert.match(result.description, /Alice requested this mission/)
  assert.match(result.description, /different authorized room member/)
})
test('wrong-role summary explains the existing role requirement', () => {
  const result = summary({id:'guest',role:'guest'}, independent)
  assert.equal(result.heading, 'Awaiting an eligible reviewer')
  assert.match(result.description, /guest role cannot decide/)
})
test('eligible independent reviewer keeps the review invitation', () => {
  const result = summary({id:'bob',role:'member'}, independent)
  assert.equal(result.heading, 'Your review is needed')
  assert.match(result.description, /Review this exact run/)
})
test('human gate without requester exclusion still allows the requester', () => {
  assert.equal(summary({id:'alice',role:'owner'}, {type:'human_approval',roles:['owner']}).heading, 'Your review is needed')
})
test('completed result does not inherit a pending-review restriction', () => {
  assert.equal(summary({id:'alice',role:'owner'}, independent, false).heading, 'The mission is complete')
})
