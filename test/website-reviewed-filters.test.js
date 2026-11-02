import test from 'node:test';import assert from 'node:assert/strict';import {websiteRequestAllowed as allowed,validateWebsiteReadEndpoints as validate}from '../src/shared/website-policy.js';
const base='https://platform.example/admin',read={method:'GET',path:'/api/cloud/listByFilters',reviewed:true,queryParameters:{enable:['0','1']}};
const request=(path,method='GET')=>({url:'https://platform.example'+path,method,resourceType:'fetch'});
test('reviewed read routes allow exact status filter values without opening arbitrary mutation-shaped parameters',()=>{
 validate([read]);assert.equal(allowed(base,request('/api/cloud/listByFilters?enable=1'),false,[]),false);
 for(const v of ['0','1'])assert.equal(allowed(base,request('/api/cloud/listByFilters?enable='+v),false,[read]),true);
 for(const q of ['enable=execute','enable=1&enable=delete','disable=1','enable=1&action=delete','enable=1&cmd=execute'])assert.equal(allowed(base,request('/api/cloud/listByFilters?'+q),false,[read]),false,q);
});
test('read filter review is exact to method, origin and path and cannot permit write routes',()=>{
 for(const r of [request('/api/other/listByFilters?enable=1'),request('/api/cloud/listByFilters?enable=1','POST'),request('/api/cloud/listByFilters?enable=1','DELETE'),request('/api/cloud/execute?enable=1'),{...request('/api/cloud/listByFilters?enable=1'),url:'https://other.example/api/cloud/listByFilters?enable=1'}])assert.equal(allowed(base,r,false,[read]),false);
 assert.throws(()=>validate([{...read,path:'/api/cloud/delete'}]));
});
test('reviewed filter config rejects action keys, credential keys, wildcard and non-string values',()=>{
 for(const queryParameters of [{action:['list']},{method:['get']},{password:['hidden']},{enable:[1]},{enable:[]},{enable:['bad\nvalue']},[],null])assert.throws(()=>validate([{...read,queryParameters}]));
 validate([{method:'GET',path:'/api/users/context',reviewed:true}]);
 assert.equal(allowed(base,request('/api/cloud/listByFilters?enable=2'),false,[read]),false);
});
