import assert from 'node:assert/strict';
import test from 'node:test';
import { RecommendationError, RecommendationLists } from '../lib/recommendations.js';

const A='M7lc1UVf-VE',B='jNQXAC9IVRw',C='dQw4w9WgXcQ';
const typed=(code,status)=>error=>error instanceof RecommendationError&&error.code===code&&error.status===status;
function setup(){let now=1000;return {store:new RecommendationLists({now:()=>now}),advance:ms=>{now+=ms}}}

test('creates unguessable list identities with a two-hour expiry and one-based item resolution',()=>{
  const {store}=setup();
  const first=store.create([A,B,C]),second=store.create([A,B,C]);
  assert.match(first.resultId,/^[A-Za-z0-9_-]{43}$/);
  assert.match(second.resultId,/^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.resultId,second.resultId);
  assert.equal(first.expiresAt,1000+7200000);
  assert.deepEqual(Object.keys(first).sort(),['expiresAt','resultId']);
  assert.equal(store.resolve(first.resultId,1),A);
  assert.equal(store.resolve(first.resultId,2),B);
  assert.equal(store.resolve(first.resultId,3),C);
});

test('a later recommendation list cannot change the older list numbering',()=>{
  const {store}=setup();
  const old=store.create([A,B,C]);
  const latest=store.create([C,A,B]);
  assert.equal(store.resolve(old.resultId,2),B);
  assert.equal(store.resolve(latest.resultId,2),A);
  assert.equal(store.resolve(old.resultId,1),A);
});

test('copies caller IDs and does not expose stored video IDs through create results',()=>{
  const {store}=setup(),ids=[A,B];
  const list=store.create(ids);
  ids.reverse();ids[0]=C;
  list.expiresAt=0;list.videoIds=[C];
  assert.equal(store.resolve(list.resultId,1),A);
  assert.equal(store.resolve(list.resultId,2),B);
});

test('rejects empty, malformed, duplicate and over-eight video lists',()=>{
  const {store}=setup();
  const invalid=[undefined,null,A,{},[],[A,A],['short'],[A+'!'],[A+'\n'],[12345678901],[[A]],Array(1),Array.from({length:9},(_,i)=>'abcdefghij'+i)];
  for(const ids of invalid)assert.throws(()=>store.create(ids),typed('invalid_list',400));
  const eight=Array.from({length:8},(_,i)=>'abcdefghij'+i);
  const list=store.create(eight);
  assert.equal(store.resolve(list.resultId,8),eight[7]);
});

test('rejects invalid item numbers and numbers beyond the selected list without changing it',()=>{
  const {store}=setup(),list=store.create([A,B]);
  for(const number of [undefined,null,0,-1,1.5,3,9,NaN,Infinity,'2',true])assert.throws(()=>store.resolve(list.resultId,number),typed('invalid_item_number',400));
  assert.equal(store.resolve(list.resultId,2),B);
});

test('distinguishes malformed and unknown list identities using safe typed errors',()=>{
  const {store}=setup();
  for(const id of [undefined,null,42,[],{},'short','a'.repeat(44),'!'.repeat(43)])assert.throws(()=>store.resolve(id,1),typed('invalid_result_id',400));
  assert.throws(()=>store.resolve('a'.repeat(43),1),typed('not_found',404));
});

test('expires at exactly two hours and never extends TTL when resolved',()=>{
  const {store,advance}=setup(),list=store.create([A,B]);
  advance(7199999);
  assert.equal(store.resolve(list.resultId,1),A);
  advance(1);
  assert.throws(()=>store.resolve(list.resultId,1),typed('expired',410));
  assert.throws(()=>store.resolve(list.resultId,2),typed('expired',410));
});

test('bounds capacity at 500 lists and reclaims an expired slot',()=>{
  const {store,advance}=setup();
  for(let i=0;i<500;i++)store.create([A]);
  assert.throws(()=>store.create([B]),typed('capacity',429));
  advance(7200000);
  const list=store.create([B]);
  assert.equal(store.resolve(list.resultId,1),B);
});

test('does not include video IDs or untrusted input in validation errors',()=>{
  const {store}=setup();
  const secret='private query or title <script>';
  for(const operation of [()=>store.create([secret]),()=>store.resolve(secret,1),()=>store.resolve('a'.repeat(43),secret)]){
    assert.throws(operation,error=>error instanceof RecommendationError&&!error.message.includes(secret)&&!error.message.includes(A));
  }
});

test('requires a callable clock when a custom clock is supplied',()=>{
  assert.throws(()=>new RecommendationLists({now:null}),TypeError);
});
